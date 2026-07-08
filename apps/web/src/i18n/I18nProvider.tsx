import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { setFormatLocale } from '../lib/format';

import {
  DEFAULT_LOCALE_CODE,
  EN_MESSAGES,
  LOCALES,
  resolveLocaleCode,
  type LocaleCode,
  type MessageNode,
} from './registry';

/**
 * The SPA i18n runtime (PROJECTPLAN.md §13.3 V3-P1). A tiny, zero-dependency
 * layer: a `t(key, vars)` translator with EN fallback, a per-user locale that
 * switches the whole app at runtime (no reload), and a hook into
 * {@link setFormatLocale} so numbers/dates follow the active language.
 *
 * **Graceful default.** `useI18n()` has a non-null default context (EN + the
 * de-AT number default), so a component rendered without a provider — e.g. in a
 * focused unit test — still translates to the EN source strings instead of
 * throwing. The live app always mounts {@link I18nProvider}, so switching works.
 */

/** `localStorage` key holding the chosen UI language (resolved to a known code). */
const STORAGE_KEY = 'bettertrack.locale';

export type TranslateVars = Record<string, string | number>;
export type TranslateFn = (key: string, vars?: TranslateVars) => string;

export interface I18nContextValue {
  /** The active locale code. */
  locale: LocaleCode;
  /** Switch languages at runtime; persists to `localStorage`. */
  setLocale: (code: string) => void;
  /** Translate a dot-path key, interpolating `{{var}}` tokens; EN fallback. */
  t: TranslateFn;
}

/** Walk a dot-path through a message tree; return the string leaf or undefined. */
function lookup(tree: MessageNode, path: string[]): string | undefined {
  let node: string | MessageNode | undefined = tree;
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Replace `{{name}}` tokens with the supplied values (unknown tokens kept). */
function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? `{{${key}}}` : String(value);
  });
}

/** Build a `t` bound to a locale's messages, falling back to EN then the key. */
function makeTranslator(messages: MessageNode): TranslateFn {
  return (key, vars) => {
    const path = key.split('.');
    const hit = lookup(messages, path) ?? lookup(EN_MESSAGES, path) ?? key;
    return interpolate(hit, vars);
  };
}

const DEFAULT_CONTEXT: I18nContextValue = {
  locale: DEFAULT_LOCALE_CODE,
  setLocale: () => {},
  t: makeTranslator(EN_MESSAGES),
};

const I18nContext = createContext<I18nContextValue>(DEFAULT_CONTEXT);

function readStoredLocale(): LocaleCode {
  try {
    return resolveLocaleCode(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_LOCALE_CODE;
  }
}

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode;
  /** Seed locale (e.g. for tests); defaults to the persisted choice / EN. */
  initialLocale?: string;
}) {
  const [locale, setLocaleState] = useState<LocaleCode>(() =>
    initialLocale !== undefined ? resolveLocaleCode(initialLocale) : readStoredLocale(),
  );

  // Keep number/date formatting in lockstep with the active locale. Set it
  // synchronously in render (idempotent, cheap) so children format correctly on
  // the very first paint — the effect below only touches the DOM/persistence.
  setFormatLocale(LOCALES[locale].intlLocale);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = useCallback((code: string) => {
    const resolved = resolveLocaleCode(code);
    setLocaleState(resolved);
    try {
      localStorage.setItem(STORAGE_KEY, resolved);
    } catch {
      // No persistence available — the runtime switch still applies for this session.
    }
  }, []);

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t: makeTranslator(LOCALES[locale].messages) }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Full i18n context: `{ locale, setLocale, t }`. */
export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

/** Convenience hook for components that only need the translator. */
export function useT(): TranslateFn {
  return useContext(I18nContext).t;
}
