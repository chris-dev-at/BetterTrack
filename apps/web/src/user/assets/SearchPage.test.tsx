import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

vi.mock('../components/AssetSearchBox', () => ({
  AssetSearchBox: () => <input aria-label="Asset search fixture" />,
}));

import { setViewportWidth } from '../../test/viewport';
import { SearchPage } from './SearchPage';

test('at 390 px the asset search page opts into the phone-safe surface', () => {
  setViewportWidth(390);
  const { container } = render(<SearchPage />);

  expect(screen.getByRole('heading', { name: 'Search' })).toBeInTheDocument();
  expect(screen.getByLabelText('Asset search fixture')).toBeInTheDocument();
  expect(container.querySelector('.bt-asset-search-page')).toBeInTheDocument();
});
