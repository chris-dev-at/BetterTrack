import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { Drawer, Field, Input, ODialog } from './components';

test('Field marks its control invalid and links the rendered error', () => {
  render(
    <>
      <span id="amount-hint">Whole euros only.</span>
      <Field error="Enter an amount." htmlFor="amount" label="Amount">
        <Input aria-describedby="amount-hint" id="amount" />
      </Field>
    </>,
  );

  const input = screen.getByLabelText('Amount');
  const error = screen.getByRole('alert');

  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAttribute('aria-describedby', 'amount-hint amount-error');
  expect(error).toHaveAttribute('id', 'amount-error');
});

test('Field keeps a required marker out of its control accessible name', () => {
  const { container } = render(
    <Field htmlFor="current-password" label="Current password">
      <Input id="current-password" required type="password" />
    </Field>,
  );

  expect(screen.getByLabelText('Current password', { exact: true })).toHaveAttribute('required');
  const marker = container.querySelector<HTMLElement>('.bt-field__required-marker')!;
  expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(marker).toHaveTextContent('*');
});

function DialogFixture() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)} type="button">
        Open editor
      </button>
      <button type="button">Behind dialog</button>
      <ODialog onClose={() => setOpen(false)} open={open} title="Edit portfolio">
        <button type="button">Cancel</button>
        <button type="button">Save</button>
      </ODialog>
    </div>
  );
}

test('ODialog inerts the background, traps focus, and restores its opener', async () => {
  const user = userEvent.setup();
  render(<DialogFixture />);

  const opener = screen.getByRole('button', { name: 'Open editor' });
  const behind = screen.getByRole('button', { name: 'Behind dialog' });
  await user.click(opener);

  const dialog = screen.getByRole('dialog', { name: 'Edit portfolio' });
  const close = within(dialog).getByRole('button', { name: 'Close' });
  const save = within(dialog).getByRole('button', { name: 'Save' });
  const scrim = dialog.closest('.bt-dialog-root')!.querySelector<HTMLElement>('.bt-scrim')!;
  expect(close).toHaveFocus();
  expect(scrim.tagName).toBe('DIV');
  expect(scrim).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  expect(opener.closest('[inert]')).not.toBeNull();
  expect(behind.closest('[inert]')).not.toBeNull();
  expect(dialog.closest('[inert]')).toBeNull();

  save.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(save).toHaveFocus();

  await user.click(scrim);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(opener.closest('[inert]')).toBeNull();
});

function DrawerFixture() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(true)} type="button">
        Add widget
      </button>
      <button type="button">Behind drawer</button>
      <Drawer onClose={() => setOpen(false)} open={open} title="Widget catalog">
        <button type="button">First widget</button>
        <button type="button">Last widget</button>
      </Drawer>
    </div>
  );
}

test('Drawer is a modal dialog with inert background, trapped focus, and restoration', async () => {
  const user = userEvent.setup();
  render(<DrawerFixture />);

  const opener = screen.getByRole('button', { name: 'Add widget' });
  const behind = screen.getByRole('button', { name: 'Behind drawer' });
  await user.click(opener);

  const drawer = screen.getByRole('dialog', { name: 'Widget catalog' });
  const close = within(drawer).getByRole('button', { name: 'Close' });
  const last = within(drawer).getByRole('button', { name: 'Last widget' });
  const scrim = drawer.parentElement!.querySelector<HTMLElement>('.bt-scrim')!;
  expect(drawer).toHaveAttribute('aria-modal', 'true');
  expect(close).toHaveFocus();
  expect(scrim.tagName).toBe('DIV');
  expect(scrim).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  expect(opener.closest('[inert]')).not.toBeNull();
  expect(behind.closest('[inert]')).not.toBeNull();
  expect(drawer.closest('[inert]')).toBeNull();

  last.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(last).toHaveFocus();

  await user.click(scrim);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(opener.closest('[inert]')).toBeNull();
});

function StackedOriginFixture() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <button onClick={() => setDrawerOpen(true)} type="button">
        Open catalog
      </button>
      <Drawer onClose={() => setDrawerOpen(false)} open={drawerOpen} title="Catalog">
        <button onClick={() => setDialogOpen(true)} type="button">
          Open details
        </button>
      </Drawer>
      <ODialog onClose={() => setDialogOpen(false)} open={dialogOpen} title="Details">
        <button type="button">Done</button>
      </ODialog>
    </>
  );
}

test('shared Escape arbitration closes the top origin overlay only', async () => {
  const user = userEvent.setup();
  render(<StackedOriginFixture />);

  await user.click(screen.getByRole('button', { name: 'Open catalog' }));
  await user.click(screen.getByRole('button', { name: 'Open details' }));

  await user.keyboard('{Escape}');

  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('dialog', { name: 'Catalog' })).toBeInTheDocument();

  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Catalog' })).not.toBeInTheDocument(),
  );
});
