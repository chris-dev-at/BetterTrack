import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { I18nProvider } from '../../../i18n';
import { FeedbackPanel } from './FeedbackPanel';

test('keeps the Settings entry compact until the feedback dialog is requested', async () => {
  const user = userEvent.setup();
  render(
    <I18nProvider initialLocale="en">
      <MemoryRouter>
        <FeedbackPanel />
      </MemoryRouter>
    </I18nProvider>,
  );

  expect(screen.queryByRole('dialog', { name: 'Send feedback' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Write feedback' }));
  expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeInTheDocument();

  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Send feedback' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Write feedback' })).toBeInTheDocument();
});
