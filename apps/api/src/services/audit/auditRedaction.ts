import { SECRET_KEYS } from '../../logger';

/**
 * Secret redaction and before/after diffing for `audit_log.meta` (#1908 §4).
 *
 * ## Why this lives on the WRITE path
 *
 * `meta` is durable for `BT_AUDIT_RETENTION_DAYS` — 400 by default. A
 * renderer-side filter would hide a secret on the audit page while leaving it
 * readable in the database, in a backup and in the next export of that table for
 * more than a year. So the marker is substituted BEFORE the row is written, and
 * the console's new drawer can only ever show what was already safe to store.
 *
 * The live example is the admin-settable AI endpoint (#1656): admin config
 * writes record their own bodies, and those bodies are shaped by whatever the
 * form grows next. Enumerating "the config fields that are secret today" would
 * be a list that rots; a key-name policy does not.
 *
 * ## Why the policy IS `SECRET_KEYS`, not a second list beside it
 *
 * {@link SECRET_KEYS} is §10's observability policy and the one place the
 * product writes down "this key name holds a credential". This module reuses it
 * verbatim rather than re-deriving a list, because two lists drift — and the
 * drift is not theoretical. The first version of this file matched a handful of
 * secret-shaped ROOTS as SUBSTRINGS (`token`, `secret`, `credential`, …) on the
 * theory that `meta` carries admin FORM bodies whose field names change with the
 * form. That theory cost a real fact on day one: `user.created` records
 * `meta.tokenId` — the registration-token ROW ID, the only link between a new
 * account and the token that admitted it (§6.12 registration modes) — and a
 * `token` substring blanked it irreversibly on every token and invite signup.
 * `logger.ts` keeps `tokenId`, `tokens`, `token_type`, `tokenEndpoint` and
 * `credentialId` BY NAME and says why; a substring policy here disagreed with
 * that documented list on six names before it had shipped once.
 *
 * So matching is WHOLE-KEY, exactly as §10's is. The one thing added on top is
 * normalisation (lower-cased, `_`/`-`/spaces removed) before the comparison,
 * which closes `Api_Key` / `api-key` / `APIKEY` — spellings a hand-authored
 * admin form can use and `SECRET_KEYS` only enumerates three of. That fold is
 * verified not to reach any documented keep: `tokenId`, `tokens`, `token_type`,
 * `tokenEndpoint`, `credentialId`, `recoveryCodeCount`, `encryptionKeyId`,
 * `accessTokenExpiresAt` and `passwordChangedAt` all normalise to something no
 * `SECRET_KEYS` entry normalises to, and the test suite pins every one of them.
 *
 * ## The cost of whole-key matching, stated
 *
 * A future admin form field whose name is secret-shaped but NOT in
 * `SECRET_KEYS` — `smtpPassword`, say — would be recorded in full. That is the
 * deliberate trade: the fix is one line in `SECRET_KEYS`, which both this and
 * the log redaction then honour together, and a policy that is precise is a
 * policy that stays trusted (the reasoning `logger.ts` spells out for rejecting
 * `code` and `otp`). Guessing at names is what produced the `tokenId` defect.
 */

/** What replaces a redacted value. Fixed, so a reader can grep for it. */
export const AUDIT_REDACTED = '[redacted]';

/** Normalised form: case- and separator-insensitive. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[\s_-]/g, '');

const SECRET_KEY_SET: ReadonlySet<string> = new Set(SECRET_KEYS.map(normalizeKey));

/**
 * Audit-specific whole-key names, on top of {@link SECRET_KEYS}.
 *
 * `credential` / `credentials` are the two names the issue's own denylist
 * enumerates that §10 does not, and neither collides with `credentialId`, which
 * `logger.ts` keeps by name — that is exactly what whole-key matching buys.
 * Anything else belongs in `SECRET_KEYS`, where both layers read it.
 */
const AUDIT_SECRET_KEYS: readonly string[] = ['credential', 'credentials'];

const AUDIT_SECRET_KEY_SET: ReadonlySet<string> = new Set(AUDIT_SECRET_KEYS.map(normalizeKey));

/**
 * Whether a key name holds something that must never reach the audit row.
 *
 * WHOLE-KEY, never a substring or a prefix: `tokenId` is a row id, `token` is a
 * credential, and only exact matching can tell them apart.
 */
export function isSecretAuditKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEY_SET.has(normalized) || AUDIT_SECRET_KEY_SET.has(normalized);
}

/**
 * How deep the walk goes before it stops trusting the input. A `meta` nested
 * deeper than this is not a shape the product writes, so the tail is dropped
 * rather than walked — the same fail-closed choice `redactForLog` makes.
 */
const MAX_DEPTH = 8;
const TOO_DEEP = '[too-deep]';

/**
 * Replace every secret-shaped value in `meta` with {@link AUDIT_REDACTED}, at
 * any depth, without mutating the input.
 *
 * REPLACES rather than drops (which is where this differs from `redactForLog`):
 * the diff view has to be able to say "the endpoint token changed" — a dropped
 * key would read as "the field was removed", which is a different and false
 * statement about what the operator did.
 */
export function redactAuditMeta<T>(meta: T): T {
  return walk(meta, 0, new Set<object>()) as T;
}

function walk(value: unknown, depth: number, ancestors: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return TOO_DEEP;

  const node = value as object;
  // A cycle cannot come out of `JSON.stringify` into jsonb anyway; guarding
  // makes the walk total rather than relying on every caller's shape.
  if (ancestors.has(node)) return TOO_DEEP;
  if (node instanceof Date) return node;

  ancestors.add(node);
  try {
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((item) => {
        const next = walk(item, depth + 1, ancestors);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : node;
    }

    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (isSecretAuditKey(key)) {
        out[key] = AUDIT_REDACTED;
        changed = true;
        continue;
      }
      const next = walk(child, depth + 1, ancestors);
      if (next !== child) changed = true;
      out[key] = next;
    }
    return changed ? out : node;
  } finally {
    ancestors.delete(node);
  }
}

/** One `{ before, after }` pair holding only the keys that actually differ. */
export interface AuditFieldDiff {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Build the `{ before, after }` pair the console's diff view renders (#1908 §4).
 *
 * Only the keys that CHANGED are recorded, so the row answers "what did this
 * operator actually do" rather than restating the whole settings object every
 * time one checkbox moves. A key present on one side only is kept on that side
 * only — that is how the renderer tells "added" from "removed" from "changed".
 *
 * Returns `null` when nothing differs, so a caller can decide not to write a
 * diff at all rather than record an empty one.
 *
 * Comparison is by canonical JSON, which is the representation the column
 * stores: two values that land in jsonb identically ARE the same value here,
 * and nothing else about object identity matters to an auditor.
 */
export function auditFieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditFieldDiff | null {
  const diff: AuditFieldDiff = { before: {}, after: {} };
  let changed = false;

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const hadBefore = Object.hasOwn(before, key);
    const hasAfter = Object.hasOwn(after, key);
    if (hadBefore && hasAfter && canonical(before[key]) === canonical(after[key])) continue;
    changed = true;
    if (hadBefore) diff.before[key] = before[key];
    if (hasAfter) diff.after[key] = after[key];
  }

  return changed ? diff : null;
}

/** Stable JSON: object key order must not make two equal values look different. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, raw: unknown) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const entries = Object.entries(raw as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries);
  });
}
