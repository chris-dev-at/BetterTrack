import { useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { Dialog } from './Dialog';
import { useMenuKeyboard } from './useMenuKeyboard';

/** A minimal disclosure menu on the shared hook — the shape every picker uses. */
function Menu({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { closeAndRestoreFocus, menuRef, onKeyDown } = useMenuKeyboard({
    open,
    onClose: () => setOpen(false),
    triggerRef,
  });

  return (
    <>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        {label}
      </button>
      {open ? (
        <div aria-label={`${label} menu`} onKeyDown={onKeyDown} ref={menuRef} role="menu">
          <button onClick={closeAndRestoreFocus} role="menuitem" type="button">
            {label} one
          </button>
          <button onClick={closeAndRestoreFocus} role="menuitem" type="button">
            {label} two
          </button>
        </div>
      ) : null}
    </>
  );
}

function MenuInDialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open sheet
      </button>
      {open ? (
        <Dialog onClose={() => setOpen(false)} title="Sheet">
          <Menu label="Audience" />
        </Dialog>
      ) : null}
    </>
  );
}

test('Escape closes the menu inside a dialog before the dialog itself', async () => {
  const user = userEvent.setup();
  render(<MenuInDialogFixture />);

  await user.click(screen.getByRole('button', { name: 'Open sheet' }));
  const menuTrigger = screen.getByRole('button', { name: 'Audience' });
  await user.click(menuTrigger);
  expect(screen.getByRole('menu', { name: 'Audience menu' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  // Only the menu goes; the dialog it belongs to stays, with focus on the
  // control that opened the menu.
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  expect(screen.getByRole('dialog', { name: 'Sheet' })).toBeInTheDocument();
  expect(menuTrigger).toHaveFocus();

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

test('Escape goes to the most recently opened of two unrelated popovers', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Menu label="First" />
      <Menu label="Second" />
    </>,
  );

  await user.click(screen.getByRole('button', { name: 'First' }));
  const second = screen.getByRole('button', { name: 'Second' });
  await user.click(second);
  // Focus is inside the second menu, and both are open.
  expect(screen.getByRole('menu', { name: 'First menu' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('menu', { name: 'Second menu' })).toBeNull());
  expect(screen.getByRole('menu', { name: 'First menu' })).toBeInTheDocument();
  expect(second).toHaveFocus();

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});
