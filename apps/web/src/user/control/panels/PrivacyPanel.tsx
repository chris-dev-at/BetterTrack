import { useT } from '../../../i18n';
import { Switch } from '../../../ui/origin';
import { useAuth } from '../../AuthContext';
import { ParkedPage } from '../../parked/ParkedPage';
import { PanelGroup, PanelHead, Row } from './panelKit';

/**
 * Control Center → Privacy modes (§13.5 V5-P13). One live switch and one parked
 * surface: discreet mode masks every absolute amount app-wide (optimistic flip,
 * rolled back by `toggleDiscreetMode` if the write fails), and the paranoid
 * vault's parking notice keeps its copy verbatim — the server only ever holds
 * ciphertext, the key never leaves the browser, and a lost passphrase means the
 * data is gone. That is the product promise, not marketing prose, so it is not
 * trimmed for popup density.
 */
export function PrivacyPanel() {
  const t = useT();
  const { user, toggleDiscreetMode } = useAuth();
  const discreet = user?.discreetMode === true;

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('control.privacy')} />

      <PanelGroup>
        <Row hint={t('privacy.discreet.body')} label={t('privacy.discreet.title')}>
          <Switch
            aria-label={t('privacy.discreet.title')}
            checked={discreet}
            onChange={() => {
              void toggleDiscreetMode().catch(() => {
                // Optimistic flip rolled back; the switch simply reflects state.
              });
            }}
          />
        </Row>
      </PanelGroup>

      <ParkedPage page="paranoid" />
    </div>
  );
}
