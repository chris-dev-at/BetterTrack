import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

vi.mock('../../lib/featureFlags', () => ({ useFeatureEnabled: vi.fn() }));
import { useFeatureEnabled } from '../../lib/featureFlags';
import { SocialLayout } from './SocialSection';

function renderLayout() {
  return render(
    <MemoryRouter>
      <SocialLayout />
    </MemoryRouter>,
  );
}

test('shows the Messages tab when chat is enabled', () => {
  vi.mocked(useFeatureEnabled).mockReturnValue(true);
  renderLayout();
  expect(screen.getByText('Friends')).toBeInTheDocument();
  expect(screen.getByText('Messages')).toBeInTheDocument();
});

test('hides the Messages tab when the chat kill-switch is OFF', () => {
  vi.mocked(useFeatureEnabled).mockReturnValue(false);
  renderLayout();
  expect(screen.getByText('Friends')).toBeInTheDocument();
  expect(screen.queryByText('Messages')).toBeNull();
});
