import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { Dialog } from './Dialog';

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open editor
      </button>
      <button type="button">Behind dialog</button>
      {open ? (
        <Dialog title="Edit portfolio" onClose={() => setOpen(false)}>
          <button type="button">Cancel</button>
          <button type="button">Save</button>
        </Dialog>
      ) : null}
    </>
  );
}

test('moves focus into the dialog and makes background controls inert', async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);

  const opener = screen.getByRole('button', { name: 'Open editor' });
  const behind = screen.getByRole('button', { name: 'Behind dialog' });
  await user.click(opener);

  expect(screen.getByRole('button', { name: 'Close dialog' })).toHaveFocus();
  expect(opener).toHaveAttribute('inert');
  expect(behind).toHaveAttribute('inert');
});

test('cycles Tab and Shift+Tab inside the dialog without reaching page content', async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);

  await user.click(screen.getByRole('button', { name: 'Open editor' }));
  const close = screen.getByRole('button', { name: 'Close dialog' });
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const save = screen.getByRole('button', { name: 'Save' });

  expect(close).toHaveFocus();
  await user.tab();
  expect(cancel).toHaveFocus();
  await user.tab();
  expect(save).toHaveFocus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(save).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Behind dialog' })).not.toHaveFocus();
});

test('closes on Escape and restores focus to its trigger', async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);

  const opener = screen.getByRole('button', { name: 'Open editor' });
  await user.click(opener);
  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(opener).not.toHaveAttribute('inert');
});
