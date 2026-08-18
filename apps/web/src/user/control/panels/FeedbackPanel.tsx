import { useState } from 'react';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { FeedbackDialog } from '../../components/FeedbackDialog';
import { PanelGroup, PanelHead, Row } from './panelKit';

/** A deliberately compact Settings entry for a secondary, write-only surface. */
export function FeedbackPanel() {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <PanelHead title={t('feedback.title')} />
      <PanelGroup>
        <Row label={t('feedback.settingsLabel')} hint={t('feedback.settingsHint')}>
          <Button icon="pen" onClick={() => setOpen(true)} variant="primary">
            {t('feedback.open')}
          </Button>
        </Row>
      </PanelGroup>
      {open ? <FeedbackDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}
