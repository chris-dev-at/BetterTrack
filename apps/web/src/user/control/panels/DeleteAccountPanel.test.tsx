import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import { DeleteAccountPanel } from './DeleteAccountPanel';

function renderPanel() {
  return render(
    <MemoryRouter>
      <DeleteAccountPanel />
    </MemoryRouter>,
  );
}

describe('DeleteAccountPanel (R2)', () => {
  test('names itself once and states the consequence', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Delete account' })).toBeInTheDocument();
    expect(screen.getByText(/permanently removes all of your data/i)).toBeInTheDocument();
    // The popup panel is a signpost, not the gate: no confirmation field, no
    // re-auth field, no destructive submit button lives here.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('lists exactly what deletion removes', () => {
    renderPanel();

    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(within(items[0]!).getByText(/portfolios, transactions/i)).toBeInTheDocument();
    expect(within(items[1]!).getByText(/friendships, shared items/i)).toBeInTheDocument();
    expect(within(items[2]!).getByText(/signed out everywhere/i)).toBeInTheDocument();
    expect(within(items[3]!).getByText(/Deleted user/i)).toBeInTheDocument();
  });

  test('the single destructive action hands off to the /account/delete gate', () => {
    renderPanel();

    // `/account/delete` is the stable public deletion URL (the Google Play
    // listing points at it) and owns the typed confirmation + re-auth.
    const action = screen.getByRole('link', { name: 'Delete my account…' });
    expect(action).toHaveAttribute('href', '/account/delete');
    expect(action).toHaveClass('bt-btn--danger');
  });
});
