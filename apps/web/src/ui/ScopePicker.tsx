import { useState } from 'react';

import {
  API_KEY_SCOPES,
  impliedReadScope,
  writeScopeForRead,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { cx } from '../lib/cx';
import { useT } from '../i18n';

const PARANOID_BLOCKED_SCOPES: ReadonlySet<ApiKeyScope> = new Set([
  'portfolio:read',
  'portfolio:write',
  'cash:read',
  'cash:write',
  'mirrorchain:read',
  'mirrorchain:write',
]);

export function isParanoidBlockedScope(scope: ApiKeyScope): boolean {
  return PARANOID_BLOCKED_SCOPES.has(scope);
}

/**
 * V5-P0b — the shared scope picker. Replaces the wall of per-scope rows with
 * ONE row per module (Portfolio, Social, …) exposing read/write marks and a
 * single "Access" toggle for the combined scope. Write-implies-read (#371) is
 * enforced client-side — the emitted scope set is byte-identical to what the
 * old flat picker produced, so the API surface is unchanged. Descriptions
 * collapse into an inline info-point; the fieldset itself can be rendered
 * collapsed via the `collapsible` prop so the OAuth-app form no longer scrolls
 * past every API-key tick.
 *
 * A read-only sibling — {@link ScopeSummary} — groups a consent payload's
 * plain-language scope labels by module for the OAuth consent screen.
 */

interface ScopeModule {
  /** i18n subkey under `ui.scopePicker.module.*`. */
  key:
    | 'portfolio'
    | 'workboard'
    | 'market'
    | 'social'
    | 'notifications'
    | 'chat'
    | 'alerts'
    | 'cash'
    | 'mirrorchain'
    | 'vaultSync'
    | 'accountSecurity';
  /** The `:read` scope for this module, or null when no read-half exists. */
  read: ApiKeyScope | null;
  /** The `:write` scope for this module, or null when the module is read-only. */
  write: ApiKeyScope | null;
  /** For single-scope modules (`account:security`) rendered as one Access toggle. */
  combined: ApiKeyScope | null;
}

/**
 * Canonical module list. Order also drives the consent-summary rendering, so a
 * new module goes here once and every surface picks it up.
 */
const SCOPE_MODULES: readonly ScopeModule[] = [
  { key: 'portfolio', read: 'portfolio:read', write: 'portfolio:write', combined: null },
  { key: 'workboard', read: 'workboard:read', write: 'workboard:write', combined: null },
  { key: 'market', read: 'market:read', write: null, combined: null },
  { key: 'social', read: 'social:read', write: 'social:write', combined: null },
  {
    key: 'notifications',
    read: 'notifications:read',
    write: 'notifications:write',
    combined: null,
  },
  { key: 'chat', read: 'chat:read', write: 'chat:write', combined: null },
  { key: 'alerts', read: 'alerts:read', write: 'alerts:write', combined: null },
  { key: 'cash', read: 'cash:read', write: 'cash:write', combined: null },
  {
    key: 'mirrorchain',
    read: 'mirrorchain:read',
    write: 'mirrorchain:write',
    combined: null,
  },
  { key: 'vaultSync', read: null, write: null, combined: 'vault:sync' },
  { key: 'accountSecurity', read: null, write: null, combined: 'account:security' },
];

/**
 * Every {@link API_KEY_SCOPES} entry must be reachable through the module list —
 * enforced at import time so appending a scope without a module row fails loud
 * instead of silently disappearing from the UI.
 */
{
  const covered = new Set<string>();
  for (const mod of SCOPE_MODULES) {
    if (mod.read) covered.add(mod.read);
    if (mod.write) covered.add(mod.write);
    if (mod.combined) covered.add(mod.combined);
  }
  for (const scope of API_KEY_SCOPES) {
    if (!covered.has(scope)) {
      throw new Error(`ScopePicker: scope ${scope} has no module row — add it to SCOPE_MODULES`);
    }
  }
}

/** Locate the module row that owns a scope, for grouping the consent summary. */
function moduleForScope(scope: ApiKeyScope): ScopeModule | undefined {
  return SCOPE_MODULES.find((m) => m.read === scope || m.write === scope || m.combined === scope);
}

/**
 * Toggle a scope with write-implies-read (#371): selecting a `:write`
 * auto-selects its `:read`, and a read stays locked on while its implying
 * `:write` is still selected.
 */
function toggleWithImplied(prev: Set<ApiKeyScope>, scope: ApiKeyScope): Set<ApiKeyScope> {
  const next = new Set(prev);
  if (next.has(scope)) {
    const write = writeScopeForRead(scope);
    if (write && next.has(write)) return prev;
    next.delete(scope);
  } else {
    next.add(scope);
    const read = impliedReadScope(scope);
    if (read) next.add(read);
  }
  return next;
}

export interface ScopePickerProps {
  scopes: Set<ApiKeyScope>;
  onChange: (next: Set<ApiKeyScope>) => void;
  /**
   * Wrap the module list in a `<details>` element so the whole picker starts
   * closed. Anti-bloat rule: OAuth-app registration no longer scrolls past
   * every API-key tick to reach the redirect-URI or public-client fields.
   */
  collapsible?: boolean;
  /** When `collapsible`, the initial open state. Defaults to `false`. */
  defaultOpen?: boolean;
  /** Overrides the fieldset legend (defaults to `ui.scopePicker.legend`). */
  legend?: string;
  /**
   * Paranoid accounts cannot grant portfolio-scoped access (§8), so that module
   * is not offered. Passed in rather than read from a hook: `ui/` also serves
   * the admin app and must stay app-agnostic.
   */
  paranoid?: boolean;
}

/** One module row: label + info-point + read/write (or combined) toggles. */
function ScopeRow({
  module,
  scopes,
  onChange,
}: {
  module: ScopeModule;
  scopes: Set<ApiKeyScope>;
  onChange: (next: Set<ApiKeyScope>) => void;
}) {
  const t = useT();
  const [infoOpen, setInfoOpen] = useState(false);
  const moduleLabel = t(`ui.scopePicker.module.${module.key}.label`);
  const description = t(`ui.scopePicker.module.${module.key}.description`);

  const { read: readScope, write: writeScope, combined } = module;
  const isReadLocked = writeScope !== null && scopes.has(writeScope);
  const readChecked = readScope !== null && (scopes.has(readScope) || isReadLocked);
  const writeChecked = writeScope !== null && scopes.has(writeScope);

  return (
    <div className="bt-scope-row">
      <div className="bt-scope-row__line">
        <div className="bt-scope-row__identity">
          <button
            type="button"
            aria-label={t('ui.scopePicker.moreInfoAria', { module: moduleLabel })}
            aria-expanded={infoOpen}
            title={description}
            onClick={() => setInfoOpen((o) => !o)}
            className="bt-scope-row__info"
          >
            i
          </button>
          <span className="bt-scope-row__label">{moduleLabel}</span>
        </div>

        <div className="bt-scope-row__choices">
          {combined !== null ? (
            <label className="bt-scope-choice">
              <input
                type="checkbox"
                checked={scopes.has(combined)}
                onChange={() => onChange(toggleWithImplied(scopes, combined))}
                aria-label={t('ui.scopePicker.accessAria', { module: moduleLabel })}
                className="bt-scope-choice__input"
              />
              {t('ui.scopePicker.access')}
            </label>
          ) : (
            <>
              {readScope !== null ? (
                <label
                  className={cx('bt-scope-choice', isReadLocked && 'opacity-70')}
                  title={isReadLocked ? t('ui.scopePicker.impliedByWrite') : undefined}
                >
                  <input
                    type="checkbox"
                    checked={readChecked}
                    disabled={isReadLocked}
                    aria-label={t('ui.scopePicker.readAria', { module: moduleLabel })}
                    onChange={() => onChange(toggleWithImplied(scopes, readScope))}
                    className="bt-scope-choice__input disabled:opacity-60"
                  />
                  {t('ui.scopePicker.read')}
                </label>
              ) : (
                <span aria-hidden="true" className="bt-scope-choice__empty">
                  —
                </span>
              )}
              {writeScope !== null ? (
                <label className="bt-scope-choice">
                  <input
                    type="checkbox"
                    checked={writeChecked}
                    aria-label={t('ui.scopePicker.writeAria', { module: moduleLabel })}
                    onChange={() => onChange(toggleWithImplied(scopes, writeScope))}
                    className="bt-scope-choice__input"
                  />
                  {t('ui.scopePicker.write')}
                </label>
              ) : (
                <span aria-hidden="true" className="bt-scope-choice__empty">
                  —
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {infoOpen ? (
        <p className="bt-scope-row__description" role="note">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export function ScopePicker({
  scopes,
  onChange,
  collapsible = false,
  defaultOpen = false,
  legend,
  paranoid = false,
}: ScopePickerProps) {
  const t = useT();
  const modules = paranoid
    ? SCOPE_MODULES.filter(
        (module) =>
          ![module.read, module.write, module.combined].some(
            (scope) => scope != null && isParanoidBlockedScope(scope),
          ),
      )
    : SCOPE_MODULES;
  const visibleScopes = paranoid
    ? new Set([...scopes].filter((scope) => !isParanoidBlockedScope(scope)))
    : scopes;

  const rows = (
    <div className="bt-scope-list">
      {modules.map((module) => (
        <ScopeRow key={module.key} module={module} scopes={visibleScopes} onChange={onChange} />
      ))}
    </div>
  );

  if (!collapsible) {
    return rows;
  }

  const count = visibleScopes.size;
  const summaryText =
    count === 0
      ? t('ui.scopePicker.selectedNone')
      : t(count === 1 ? 'ui.scopePicker.selectedOne' : 'ui.scopePicker.selectedOther', {
          count,
        });
  const summaryLabel = legend ?? t('ui.scopePicker.legend');

  return (
    <details className="bt-scope-fold" open={defaultOpen}>
      <summary className="bt-scope-fold__summary">
        <span>{summaryLabel}</span>
        <span className="bt-scope-fold__meta">{summaryText}</span>
      </summary>
      <div className="bt-scope-fold__body">{rows}</div>
    </details>
  );
}

export interface ScopeSummaryProps {
  /** The scopes payload from the consent-details endpoint (server-labeled). */
  items: readonly { scope: ApiKeyScope; label: string }[];
}

/**
 * Read-only display of a requested scope set, grouped by module. Used on the
 * OAuth consent screen so a user reviews permissions as coherent groups
 * (Portfolio, Social, …) rather than a flat list of one-liners.
 */
type ScopeClaim = { scope: ApiKeyScope; label: string };
type ScopeGroup = { module: ScopeModule; claims: ScopeClaim[] };

export function ScopeSummary({ items }: ScopeSummaryProps) {
  const t = useT();
  // Every requested claim is shown, always: a consent screen that shortened its
  // own list would understate what the caller is about to hold. A paranoid
  // account never reaches this render with a portfolio scope in `items` —
  // ConsentPage refuses the whole authorization first (§8).
  const grouped: ScopeGroup[] = [];
  for (const module of SCOPE_MODULES) {
    const claims = items.filter((item) => moduleForScope(item.scope)?.key === module.key);
    if (claims.length > 0) grouped.push({ module, claims: [...claims] });
  }

  return (
    <ul className="bt-scope-summary">
      {grouped.map(({ module, claims }) => (
        <li key={module.key} className="bt-scope-summary__item">
          <span aria-hidden="true" className="bt-scope-summary__mark">
            ✓
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="bt-scope-summary__label">
              {t(`ui.scopePicker.module.${module.key}.label`)}
            </span>
            <ul className="bt-scope-summary__claims">
              {claims.map(({ scope, label }) => (
                <li key={scope}>{label}</li>
              ))}
            </ul>
          </div>
        </li>
      ))}
    </ul>
  );
}
