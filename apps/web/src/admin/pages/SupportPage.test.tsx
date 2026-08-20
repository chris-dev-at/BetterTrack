import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';
import { SupportPage } from './SupportPage';

function renderPage(locale: 'en' | 'de' = 'en') {
  return render(
    <I18nProvider initialLocale={locale}>
      <MemoryRouter>
        <SupportPage />
      </MemoryRouter>
    </I18nProvider>,
  );
}

test('is honest that the helpdesk console is not built yet, and forwards to the inbox', () => {
  renderPage();

  expect(screen.getByRole('heading', { name: 'Support' })).toBeInTheDocument();
  expect(screen.getByText(/arrives with W3/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open the feedback inbox' })).toHaveAttribute(
    'href',
    '/admin/feedback',
  );
});

test('renders in German', () => {
  renderPage('de');

  expect(screen.getByRole('heading', { name: 'Support' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Feedback-Postfach öffnen' })).toBeInTheDocument();
});
