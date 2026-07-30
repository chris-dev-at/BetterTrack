import { Link } from 'react-router-dom';

import { useT } from '../../../i18n';
import { PanelHead, PanelNote } from './panelKit';

/** What deletion removes — the four irreversible consequences, in one list. */
const REMOVAL_KEYS = [
  'deleteAccount.warning.data',
  'deleteAccount.warning.social',
  'deleteAccount.warning.access',
  'deleteAccount.warning.chat',
] as const;

/**
 * Control Center → Delete account (R2). The popup's danger panel is a
 * SIGNPOST, not the deletion form: it states the consequence, lists what is
 * removed, and hands off to `/account/delete`.
 *
 * The gate itself deliberately stays a standalone page. `/account/delete` is the
 * stable public deletion URL the Google Play listing points at, and every real
 * guard — the typed username confirmation, the password/TOTP re-auth, the
 * server-side mirror of both — lives there. Mounting that full gate screen
 * inside a 960×660 popup (and letting CSS strip its paint) is what this panel
 * replaces.
 */
export function DeleteAccountPanel() {
  const t = useT();
  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.deleteAccount')} />

      <PanelNote warn>{t('settings.dangerZone.description')}</PanelNote>

      <ul className="list-disc pl-4">
        {REMOVAL_KEYS.map((key) => (
          <li className="bt-cc-note" key={key}>
            {t(key)}
          </li>
        ))}
      </ul>

      {/* The single destructive action, at the bottom: it LEAVES the popup for
          the gate that owns the confirmation and re-auth. */}
      <div>
        <Link className="bt-btn bt-btn--danger bt-btn--sm" to="/account/delete">
          {t('settings.dangerZone.link')}
        </Link>
      </div>
    </div>
  );
}
