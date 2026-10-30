import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useT } from '../../../i18n';
import { Button } from '../../../ui/origin';
import { FeedbackDialog } from '../../components/FeedbackDialog';
import { MyFeedbackSubmissions } from './MyFeedbackSubmissions';
import { MY_FEEDBACK_QUERY_KEY } from './myFeedbackCache';
import { PanelGroup, PanelHead, Row } from './panelKit';

/**
 * Control Center → Feedback: write a new report, then follow every earlier one
 * — its status, the team's replies, and withdraw — in the same panel.
 */
export function FeedbackPanel({ screen }: { screen?: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  return (
    <div className="bt-cc-panel">
      <PanelHead title={t('feedback.title')} />
      <PanelGroup>
        <Row label={t('feedback.settingsLabel')} hint={t('feedback.settingsHint')}>
          <Button icon="pen" onClick={() => setOpen(true)} variant="primary">
            {t('feedback.open')}
          </Button>
        </Row>
      </PanelGroup>
      <MyFeedbackSubmissions />
      {open ? (
        <FeedbackDialog
          onClose={() => setOpen(false)}
          onSubmitted={() =>
            void queryClient.invalidateQueries({ queryKey: MY_FEEDBACK_QUERY_KEY })
          }
          screen={screen}
        />
      ) : null}
    </div>
  );
}
