import { useState } from 'react';

import {
  API_KEY_SCOPES,
  impliedReadScope,
  writeScopeForRead,
  type ApiKeyScope,
} from '@bettertrack/contracts';

import { cx } from '../lib/cx';
import { useT } from '../i18n';

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
    <div className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <button
            type="button"
            aria-label={t('ui.scopePicker.moreInfoAria', { module: moduleLabel })}
            aria-expanded={infoOpen}
            title={description}
            onClick={() => setInfoOpen((o) => !o)}
            className="grid h-5 w-5 flex-none place-items-center rounded-full border border-neutral-700 text-[0.6rem] font-semibold leading-none text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            i
          </button>
          <span className="text-sm font-medium text-neutral-100">{moduleLabel}</span>
        </div>

        <div className="flex items-center gap-4">
          {combined !== null ? (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-300">
              <input
                type="checkbox"
                checked={scopes.has(combined)}
                onChange={() => onChange(toggleWithImplied(scopes, combined))}
                aria-label={t('ui.scopePicker.accessAria', { module: moduleLabel })}
                className="h-4 w-4 accent-sky-500"
              />
              {t('ui.scopePicker.access')}
            </label>
          ) : (
            <>
              {readScope !== null ? (
                <label
                  className={cx(
                    'flex cursor-pointer items-center gap-2 text-xs text-neutral-300',
                    isReadLocked && 'opacity-70',
                  )}
                  title={isReadLocked ? t('ui.scopePicker.impliedByWrite') : undefined}
                >
                  <input
                    type="checkbox"
                    checked={readChecked}
                    disabled={isReadLocked}
                    aria-label={t('ui.scopePicker.readAria', { module: moduleLabel })}
                    onChange={() => onChange(toggleWithImplied(scopes, readScope))}
                    className="h-4 w-4 accent-sky-500 disabled:opacity-60"
                  />
                  {t('ui.scopePicker.read')}
                </label>
              ) : (
                <span aria-hidden="true" className="w-16 text-center text-xs text-neutral-700">
                  —
                </span>
              )}
              {writeScope !== null ? (
                <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-300">
                  <input
                    type="checkbox"
                    checked={writeChecked}
                    aria-label={t('ui.scopePicker.writeAria', { module: moduleLabel })}
                    onChange={() => onChange(toggleWithImplied(scopes, writeScope))}
                    className="h-4 w-4 accent-sky-500"
                  />
                  {t('ui.scopePicker.write')}
                </label>
              ) : (
                <span aria-hidden="true" className="w-16 text-center text-xs text-neutral-700">
                  —
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {infoOpen ? (
        <p className="mt-2 text-xs text-neutral-500" role="note">
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
}: ScopePickerProps) {
  const t = useT();

  const rows = (
    <div className="flex flex-col gap-1.5">
      {SCOPE_MODULES.map((module) => (
        <ScopeRow key={module.key} module={module} scopes={scopes} onChange={onChange} />
      ))}
    </div>
  );

  if (!collapsible) {
    return rows;
  }

  const count = scopes.size;
  const summaryText =
    count === 0
      ? t('ui.scopePicker.selectedNone')
      : t(count === 1 ? 'ui.scopePicker.selectedOne' : 'ui.scopePicker.selectedOther', {
          count,
        });
  const summaryLabel = legend ?? t('ui.scopePicker.legend');

  return (
    <details className="rounded-md border border-neutral-800 bg-neutral-900" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-neutral-200 marker:hidden [&::-webkit-details-marker]:hidden">
        <span>{summaryLabel}</span>
        <span className="text-xs text-neutral-500">{summaryText}</span>
      </summary>
      <div className="border-t border-neutral-800 p-3">{rows}</div>
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
  const grouped: ScopeGroup[] = [];
  for (const module of SCOPE_MODULES) {
    const claims = items.filter((item) => moduleForScope(item.scope)?.key === module.key);
    if (claims.length > 0) grouped.push({ module, claims: [...claims] });
  }

  return (
    <ul className="flex flex-col gap-2">
      {grouped.map(({ module, claims }) => (
        <li
          key={module.key}
          className="flex items-start gap-3 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2"
        >
          <span aria-hidden="true" className="mt-0.5 text-sky-400">
            ✓
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium text-neutral-100">
              {t(`ui.scopePicker.module.${module.key}.label`)}
            </span>
            <ul className="flex flex-col gap-0.5 text-xs text-neutral-300">
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
