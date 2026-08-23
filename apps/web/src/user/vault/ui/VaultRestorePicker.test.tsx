import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RestoreCandidate } from '../restore';
import { VaultRestorePicker } from './VaultRestorePicker';

function candidate(id: string, status: RestoreCandidate['status']): RestoreCandidate {
  return {
    id,
    source: 'server-history',
    medium: 'server',
    envelope: new Uint8Array([1]),
    version: 2,
    updatedAt: '2026-08-20T10:00:00.000Z',
    status,
  };
}

describe('VaultRestorePicker', () => {
  it('keeps corrupt history candidates visible and clearly non-current', () => {
    const restore = vi.fn();
    render(
      <VaultRestorePicker
        candidates={[candidate('good', 'available'), candidate('bad', 'corrupt')]}
        onRestore={restore}
      />,
    );

    expect(screen.getAllByText('BetterTrack history')).toHaveLength(2);
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Corrupt — cannot restore')).toBeInTheDocument();
    expect(screen.getAllByRole('radio')[0]).toBeEnabled();
    expect(screen.getAllByRole('radio')[1]).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();
  });
});
