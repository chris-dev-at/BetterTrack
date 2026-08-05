import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test } from 'vitest';

import { TransactionsPage } from './PortfolioSection';

test('points transactions users to the overview while retaining their portfolio', () => {
  render(
    <MemoryRouter initialEntries={['/portfolio/activity?portfolio=portfolio-7']}>
      <TransactionsPage />
    </MemoryRouter>,
  );

  expect(screen.getByRole('link', { name: 'Open portfolio overview' })).toHaveAttribute(
    'href',
    '/portfolio?portfolio=portfolio-7',
  );
});
