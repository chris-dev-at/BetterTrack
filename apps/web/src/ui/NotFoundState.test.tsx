import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, test } from 'vitest';

import { NotFoundState } from './NotFoundState';

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

test('shows the requested pathname as inert text and provides both ways back', async () => {
  const user = userEvent.setup();

  render(
    <MemoryRouter initialEntries={['/previous', '/missing-route']}>
      <LocationProbe />
      <NotFoundState homeTo="/" />
    </MemoryRouter>,
  );

  const requestedPath = screen.getByText('/missing-route', { selector: 'code' });
  expect(requestedPath.tagName).toBe('CODE');
  expect(requestedPath.closest('a')).toBeNull();
  expect(screen.getByRole('link', { name: 'Back to start' })).toHaveAttribute('href', '/');

  await user.click(screen.getByRole('button', { name: 'Back to previous page' }));
  expect(screen.getByTestId('location')).toHaveTextContent('/previous');
});
