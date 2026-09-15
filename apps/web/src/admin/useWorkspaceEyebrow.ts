import { useLocation } from 'react-router-dom';

import { useT } from '../i18n';
import { adminWorkspaceLabelKeyForPath } from './adminWorkspaces';

/**
 * The localized workspace label for the page currently rendering — the console's
 * uniform `PageHeader` eyebrow (#1406 W7b).
 *
 * Resolved from `adminWorkspaces.ts` rather than hand-written per page. Before
 * this, fifteen of the console's twenty-three pages carried a literal
 * `t('admin.nav.sections.operations')` and eight carried nothing at all, so
 * "where am I" was answered inconsistently and a page that moved workspace would
 * have kept announcing the old one until someone noticed. One registry, one
 * answer.
 *
 * Returns `undefined` for a path the registry does not own (a detail route
 * nobody named); `PageHeader` then renders no eyebrow, which is the same thing
 * the eight uncovered pages did before.
 */
export function useWorkspaceEyebrow(): string | undefined {
  const t = useT();
  const { pathname } = useLocation();
  const labelKey = adminWorkspaceLabelKeyForPath(pathname);
  return labelKey ? t(labelKey) : undefined;
}
