import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { pointerInSeparateOverlay, useOverlayEscape } from './overlayStack';

function TestDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useOverlayEscape(true, onClose, dialogRef);

  return (
    <div aria-label={title} ref={dialogRef} role="dialog">
      {children}
    </div>
  );
}

/** A picker-shaped disclosure stand-in wired directly to the shared Escape stack. */
function Menu({ label }: { label: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  useOverlayEscape(open, closeAndRestoreFocus, menuRef);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

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
        <div aria-label={`${label} menu`} ref={menuRef} role="menu">
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
        <TestDialog onClose={() => setOpen(false)} title="Sheet">
          <Menu label="Audience" />
        </TestDialog>
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

/**
 * The click-away half. A popover that opens a PORTALLED dialog used to dismiss
 * itself on that dialog's first click — and, because the dialog is its child in
 * React, take the dialog down with it. `pointerInSeparateOverlay` is what tells
 * the two layers apart; these three cases are the ones it has to get right.
 */
function PopoverWithDialog() {
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (pointerInSeparateOverlay(target, rootRef.current)) return;
      if (!rootRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        Open popover
      </button>
      <p>page content</p>
      {open ? (
        <div ref={rootRef}>
          <span>popover body</span>
          <button onClick={() => setDialogOpen(true)} type="button">
            Unlock
          </button>
          {dialogOpen
            ? createPortal(
                <TestDialog onClose={() => setDialogOpen(false)} title="Prompt">
                  <button type="button">Confirm</button>
                </TestDialog>,
                document.body,
              )
            : null}
        </div>
      ) : null}
    </>
  );
}

test('a popover survives clicks inside the dialog it portalled open', async () => {
  const user = userEvent.setup();
  render(<PopoverWithDialog />);

  await user.click(screen.getByRole('button', { name: 'Open popover' }));
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  expect(screen.getByRole('dialog', { name: 'Prompt' })).toBeTruthy();

  // THE REGRESSION: this click used to dismiss the popover, which unmounted the
  // dialog the user had only just been given.
  await user.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(screen.getByRole('dialog', { name: 'Prompt' })).toBeTruthy();
  expect(screen.getByText('popover body')).toBeTruthy();

  // …and ordinary page content still dismisses it, which is the whole point of
  // a click-away handler.
  await user.click(screen.getByText('page content'));
  await waitFor(() => expect(screen.queryByText('popover body')).toBeNull());
});

test('pointerInSeparateOverlay leaves containment cases alone', () => {
  const outside = document.createElement('div');
  document.body.append(outside);
  // No registered overlay contains it ⇒ an ordinary click, and a dismissal.
  expect(pointerInSeparateOverlay(outside, null)).toBe(false);
  outside.remove();
});
