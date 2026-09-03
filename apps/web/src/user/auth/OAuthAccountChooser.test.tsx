import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// The chooser only needs `quickAuth` from the auth context; the ladder itself is
// covered end-to-end in LoginPage.test.tsx and on the server.
vi.mock('../AuthContext', () => ({
  useAuth: () => ({ quickAuth: vi.fn() }),
}));

import { Avatar } from '../components/Avatar';
import { OAuthAccountChooser } from './OAuthAccountChooser';
import type { RememberedAccount } from './rememberedAccount';

/**
 * The OAuth account chooser's face (§13.5 V5-P0 (c), #1684). The screen's whole
 * job is "confirm this is you", so a user who picked a curated profile icon must
 * see THAT icon — the same one every social surface renders — and a user who
 * never picked one must still see the lettered tile rather than a blank or a
 * broken image.
 */

const account: RememberedAccount = {
  userId: '8d7cf3d6-e8b8-4fa4-98a4-8712cddc05bf',
  username: 'jane',
  profileIcon: null,
};

function renderChooser(overrides: Partial<RememberedAccount>) {
  return render(
    <OAuthAccountChooser
      account={{ ...account, ...overrides }}
      onAuthenticated={vi.fn()}
      onAnotherAccount={vi.fn()}
    />,
  );
}

function iconMarkup(container: HTMLElement): string | null {
  return container.querySelector('svg[viewBox="0 0 64 64"]')?.innerHTML ?? null;
}

describe('OAuthAccountChooser — the remembered account’s avatar', () => {
  test('renders the curated icon the remembered user picked', () => {
    const { container } = renderChooser({ profileIcon: 'fox' });
    const { container: expected } = render(<Avatar name="jane" iconId="fox" size="md" />);

    expect(iconMarkup(container)).toBe(iconMarkup(expected));
    // The identity row is still the chooser's main tap target.
    expect(screen.getByRole('button', { name: /Log in as jane/i })).toBeInTheDocument();
  });

  test('falls back to the lettered tile when no icon was ever picked', () => {
    const { container } = renderChooser({ profileIcon: null });

    expect(iconMarkup(container)).toBeNull();
    const tile = container.querySelector('.bt-avatar');
    expect(tile).not.toBeNull();
    expect(tile?.textContent).toBe('J');
  });
});
