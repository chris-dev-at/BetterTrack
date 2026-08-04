import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

import { setViewportWidth } from '../../../test/viewport';

vi.mock('./CashTagsPage', () => ({
  CashTagsPage: () => <section>Tag setup</section>,
}));
vi.mock('./CashRulesPage', () => ({
  CashRulesPage: () => <section>Rule setup</section>,
}));

import { CashLabelsPage } from './CashLabelsPage';

test('390px keeps both label tools and the return action in one contained surface', () => {
  setViewportWidth(390);
  render(
    <MemoryRouter>
      <CashLabelsPage />
    </MemoryRouter>,
  );

  const heading = screen.getByRole('heading', { name: 'Labels & rules' });
  const surface = heading.closest('.bt-money-surface');
  expect(surface).not.toBeNull();
  expect(screen.getByRole('link', { name: 'Back to movements' })).toBeInTheDocument();
  expect(screen.getByText('Tag setup')).toBeInTheDocument();
  expect(screen.getByText('Rule setup')).toBeInTheDocument();
});
