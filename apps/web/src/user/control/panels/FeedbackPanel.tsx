import { useState } from 'react';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { FeedbackDialog } from '../../components/FeedbackDialog';
import { MyFeedbackSubmissionsDialog } from '../../components/MyFeedbackSubmissionsDialog';
import { PanelGroup, PanelHead, Row } from './panelKit';

/** A compact Settings home for feedback capture and submitter follow-up. */
export function FeedbackPanel({ screen }: { screen?: string }) {
  const t = useT();
  const [open, setOpen] = useState<'write' | 'submissions' | null>(null);

  return (
    <>
      <PanelHead title={t('feedback.panelTitle')} />
      <PanelGroup>
        <Row label={t('feedback.settingsLabel')} hint={t('feedback.settingsHint')}>
          <Button icon="pen" onClick={() => setOpen('write')} variant="primary">
            {t('feedback.open')}
          </Button>
        </Row>
        <Row label={t('feedback.mySubmissionsLabel')} hint={t('feedback.mySubmissionsHint')}>
          <Button onClick={() => setOpen('submissions')} variant="quiet">
            {t('feedback.mySubmissionsOpen')}
          </Button>
        </Row>
      </PanelGroup>
      {open === 'write' ? <FeedbackDialog onClose={() => setOpen(null)} screen={screen} /> : null}
      {open === 'submissions' ? (
        <MyFeedbackSubmissionsDialog
          onClose={() => setOpen(null)}
          onWriteFeedback={() => setOpen('write')}
        />
      ) : null}
    </>
  );
}
