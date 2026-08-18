import type { ApiKeyScope } from '@bettertrack/contracts';

import type { TranslateFn } from '../i18n';

/** Stable i18n path for one OAuth/API-key scope's user-facing description. */
export function oauthScopeDescriptionKey(scope: ApiKeyScope): string {
  return `ui.scopePicker.scopeDescription.${scope}`;
}

/**
 * Resolve consent/grant copy from the stable scope id. The server-supplied
 * English label remains a defensive fallback for a partially deployed web
 * bundle, but it is never used as the localization key.
 */
export function localizedOAuthScopeDescription(
  t: TranslateFn,
  scope: ApiKeyScope,
  fallback: string,
): string {
  const key = oauthScopeDescriptionKey(scope);
  const localized = t(key);
  return localized === key ? fallback : localized;
}
