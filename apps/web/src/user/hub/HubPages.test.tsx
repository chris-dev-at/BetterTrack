import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { setViewportWidth } from '../../test/viewport';
import { DeveloperPlatformPage } from './HubPages';

test('at 390 px every developer hub destination stays in the phone-safe list', () => {
  setViewportWidth(390);
  const { container } = render(
    <MemoryRouter>
      <DeveloperPlatformPage />
    </MemoryRouter>,
  );

  expect(screen.getByRole('link', { name: /API keys/ })).toHaveAttribute('href', '/control/api');
  expect(screen.getByRole('link', { name: /Webhooks/ })).toHaveAttribute(
    'href',
    '/control/webhooks',
  );
  expect(screen.getByRole('link', { name: /Send feedback/ })).toHaveAttribute(
    'href',
    '/control/feedback',
  );
  expect(container.querySelector('.bt-hub-page')).toBeInTheDocument();
});
