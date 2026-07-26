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

test('follows positive tabindex order when focusing and wrapping', async () => {
  const user = userEvent.setup();
  render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <button>Normal tab stop</button>
      <button tabIndex={2}>Second tab stop</button>
      <button tabIndex={1}>First tab stop</button>
    </Modal>,
  );

  const normal = screen.getByRole('button', { name: 'Normal tab stop' });
  const second = screen.getByRole('button', { name: 'Second tab stop' });
  const first = screen.getByRole('button', { name: 'First tab stop' });

  expect(first).toHaveFocus();

  await user.tab({ shift: true });
  expect(normal).toHaveFocus();

  await user.tab();
  expect(first).toHaveFocus();

  await user.tab();
  expect(second).toHaveFocus();

  await user.tab();
  expect(normal).toHaveFocus();
});

test('wraps around a checked radio before unchecked group members', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Modal title="Edit user" onClose={vi.fn()}>
        <button>Before choices</button>
        <input type="radio" name="role" aria-label="Selected role" defaultChecked />
        <input type="radio" name="role" aria-label="Other role" />
      </Modal>
      <button>Outside modal</button>
    </>,
  );

  const before = screen.getByRole('button', { name: 'Before choices' });
  const selected = screen.getByRole('radio', { name: 'Selected role' });

  expect(before).toHaveFocus();

  await user.tab();
  expect(selected).toHaveFocus();

  await user.tab();
  expect(before).toHaveFocus();

  await user.tab({ shift: true });
  expect(selected).toHaveFocus();
});

test('wraps around a checked radio after unchecked group members', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Modal title="Edit user" onClose={vi.fn()}>
        <input type="radio" name="role" aria-label="Other role" />
        <input type="radio" name="role" aria-label="Selected role" defaultChecked />
        <button>After choices</button>
      </Modal>
      <button>Outside modal</button>
    </>,
  );

  const selected = screen.getByRole('radio', { name: 'Selected role' });
  const after = screen.getByRole('button', { name: 'After choices' });

  expect(selected).toHaveFocus();

  await user.tab({ shift: true });
  expect(after).toHaveFocus();

  await user.tab();
  expect(selected).toHaveFocus();
});

test("uses the first radio as an unchecked group's focus entry", () => {
  render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <input type="radio" name="role" aria-label="First role" />
      <input type="radio" name="role" aria-label="Second role" />
    </Modal>,
  );

  expect(screen.getByRole('radio', { name: 'First role' })).toHaveFocus();
});

test('excludes tabindex=-1 controls when wrapping Tab and Shift+Tab', async () => {
  const user = userEvent.setup();
  render(
    <Modal title="Edit user" onClose={vi.fn()}>
      <button tabIndex={-1}>Programmatic first</button>
      <button>Save changes</button>
      <button tabIndex={-1}>Programmatic last</button>
    </Modal>,
  );

  const save = screen.getByRole('button', { name: 'Save changes' });

  expect(save).toHaveFocus();

  await user.tab();
  expect(save).toHaveFocus();

  await user.tab({ shift: true });
  expect(save).toHaveFocus();
});

test('excludes controls hidden directly or by an ancestor from the tab order', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Modal title="Edit user" onClose={vi.fn()}>
        <div hidden>
          <button>Hidden by ancestor</button>
        </div>
        <button>Save changes</button>
        <button style={{ display: 'none' }}>Hidden directly</button>
      </Modal>
      <button>Outside modal</button>
    </>,
  );

  const save = screen.getByRole('button', { name: 'Save changes' });

  expect(save).toHaveFocus();

  await user.tab();
  expect(save).toHaveFocus();

  await user.tab({ shift: true });
  expect(save).toHaveFocus();
});

test('treats a summary as a focusable control and skips closed details content', async () => {
  const user = userEvent.setup();
  render(
    <Modal title="Details" onClose={vi.fn()}>
      <details>
        <summary>More details</summary>
        <button>Hidden detail action</button>
      </details>
    </Modal>,
  );

  const summary = screen.getByText('More details');

  expect(summary).toHaveFocus();

  await user.tab();
  expect(summary).toHaveFocus();

  await user.tab({ shift: true });
  expect(summary).toHaveFocus();
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

test('restores focus to the opener when a descendant uses autoFocus', () => {
  const opener = document.createElement('button');
  opener.textContent = 'Open modal';
  document.body.append(opener);
  opener.focus();

  const { unmount } = render(
    <Modal title="Create user" onClose={vi.fn()}>
      <input aria-label="Email" autoFocus />
    </Modal>,
  );

  expect(screen.getByRole('textbox', { name: 'Email' })).toHaveFocus();

  unmount();

  expect(opener).toHaveFocus();
  opener.remove();
});
