import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { Modal } from './Modal';

test('focuses the first enabled descendant when it opens', () => {
  render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <button disabled>Disabled action</button>
      <button>Save changes</button>
    </Modal>,
  );

  expect(screen.getByRole('button', { name: 'Save changes' })).toHaveFocus();
});

test('focuses the dialog when it has no focusable descendants', () => {
  render(
    <Modal title="Details" onClose={vi.fn()}>
      <p>Nothing to change.</p>
    </Modal>,
  );

  expect(screen.getByRole('dialog', { name: 'Details' })).toHaveFocus();
});

test('wraps Tab and Shift+Tab within the dialog', async () => {
  const user = userEvent.setup();
  render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <button>Cancel</button>
      <button>Save changes</button>
    </Modal>,
  );

  const cancel = screen.getByRole('button', { name: 'Cancel' });
  const save = screen.getByRole('button', { name: 'Save changes' });

  expect(cancel).toHaveFocus();

  await user.tab();
  expect(save).toHaveFocus();

  await user.tab();
  expect(cancel).toHaveFocus();

  await user.tab({ shift: true });
  expect(save).toHaveFocus();
});

test('keeps Escape handling and its accessible title', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(
    <Modal title="Delete user" onClose={onClose}>
      <button>Delete</button>
    </Modal>,
  );

  const dialog = screen.getByRole('dialog', { name: 'Delete user' });
  const title = screen.getByRole('heading', { name: 'Delete user' });

  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(dialog).toHaveAttribute('aria-labelledby', title.id);

  await user.keyboard('{Escape}');

  expect(onClose).toHaveBeenCalledOnce();
});

test('restores focus to the opener when the modal unmounts', () => {
  const opener = document.createElement('button');
  opener.textContent = 'Open modal';
  document.body.append(opener);
  opener.focus();

  const { unmount } = render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <button>Save changes</button>
    </Modal>,
  );

  unmount();

  expect(opener).toHaveFocus();
  opener.remove();
});
