import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DriveNotConfiguredError } from './driveConfiguration';
import { useDriveGisPreparation } from './useDriveGisPreparation';

function Probe({
  enabled,
  prepare,
  onReset,
}: {
  enabled: boolean;
  prepare: (() => Promise<void>) | null;
  onReset?: () => void;
}) {
  const preparation = useDriveGisPreparation(enabled, prepare, { onReset });
  return (
    <button onClick={preparation.retry} type="button">
      {preparation.state}
    </button>
  );
}

describe('useDriveGisPreparation', () => {
  it('separates a deployment without a Drive client id from a failed GIS load', async () => {
    const unconfigured = vi.fn(() => Promise.reject(new DriveNotConfiguredError()));
    const { unmount } = render(<Probe enabled prepare={unconfigured} />);
    expect(await screen.findByRole('button', { name: 'unconfigured' })).toBeInTheDocument();
    unmount();

    const offline = vi.fn(() => Promise.reject(new Error('script load failed')));
    render(<Probe enabled prepare={offline} />);
    expect(await screen.findByRole('button', { name: 'failed' })).toBeInTheDocument();
  });

  it('retries a failed preparation from the caller gesture', async () => {
    const user = userEvent.setup();
    const prepare = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('script load failed'))
      .mockResolvedValueOnce(undefined);
    render(<Probe enabled prepare={prepare} />);

    await user.click(await screen.findByRole('button', { name: 'failed' }));
    expect(await screen.findByRole('button', { name: 'ready' })).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledTimes(2);
  });

  it('never re-runs preparation because its callbacks lost referential stability', async () => {
    // #1519 F6: `onReset` drops the Drive capability the surface captured, so a
    // caller that re-creates `prepare` every render must not be able to restart
    // preparation — that would silently revoke a consent mid-flow.
    const prepare = vi.fn(async () => undefined);
    const onReset = vi.fn();
    const view = render(<Probe enabled onReset={onReset} prepare={prepare} />);
    expect(await screen.findByRole('button', { name: 'ready' })).toBeInTheDocument();
    expect(onReset).toHaveBeenCalledTimes(1);

    for (let pass = 0; pass < 3; pass += 1) {
      view.rerender(<Probe enabled onReset={() => onReset()} prepare={() => prepare()} />);
    }

    expect(screen.getByRole('button', { name: 'ready' })).toBeInTheDocument();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('resets to idle and tells the caller when the surface switches preparation off', async () => {
    const onReset = vi.fn();
    const view = render(<Probe enabled onReset={onReset} prepare={async () => undefined} />);
    expect(await screen.findByRole('button', { name: 'ready' })).toBeInTheDocument();

    await act(async () => {
      view.rerender(<Probe enabled={false} onReset={onReset} prepare={async () => undefined} />);
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'idle' })).toBeInTheDocument());
    expect(onReset).toHaveBeenCalledTimes(2);
  });
});
