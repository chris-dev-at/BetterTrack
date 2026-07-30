import { useRef, useState } from 'react';
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
  // The panel is portalled to <body>, so inertness is applied to the branch the
  // page lives on rather than to each control.
  expect(opener.closest('[inert]')).not.toBeNull();
  expect(behind.closest('[inert]')).not.toBeNull();
  expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
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
  expect(opener.closest('[inert]')).toBeNull();
});

/**
 * The supported composition: `MirrorchainPanel`'s member sheet renders the
 * invite / rename / confirm dialogs inside itself.
 */
function NestedDialogFixture() {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setSheetOpen(true)}>
        Open members
      </button>
      {sheetOpen ? (
        <Dialog title="Members" onClose={() => setSheetOpen(false)}>
          <button type="button" onClick={() => setInviteOpen(true)}>
            Invite a friend
          </button>
          {inviteOpen ? (
            <Dialog title="Invite" onClose={() => setInviteOpen(false)}>
              <button type="button">Send invite</button>
            </Dialog>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}

test('Escape closes only the innermost dialog and leaves its parent standing', async () => {
  const user = userEvent.setup();
  render(<NestedDialogFixture />);

  await user.click(screen.getByRole('button', { name: 'Open members' }));
  const invite = screen.getByRole('button', { name: 'Invite a friend' });
  await user.click(invite);

  expect(screen.getByRole('dialog', { name: 'Invite' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  // The child is gone; the parent — and the context the user is halfway
  // through — is not, and focus is back on the control that opened the child.
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Invite' })).toBeNull());
  const parent = screen.getByRole('dialog', { name: 'Members' });
  expect(parent).toBeInTheDocument();
  expect(invite).toHaveFocus();
  expect(parent.contains(document.activeElement)).toBe(true);

  // A second Escape then closes the parent, in order.
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

/**
 * The switcher's create-group flow (`PortfolioSwitcher`): a successful create
 * unmounts one dialog as the next mounts, so the second dialog's opener is a
 * control inside the retiring one.
 */
function HandoffFixture({ stableTrigger }: { stableTrigger: boolean }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [step, setStep] = useState<'idle' | 'create' | 'invite'>('idle');
  return (
    <>
      <main>
        <button ref={triggerRef} type="button" onClick={() => setStep('create')}>
          New group portfolio
        </button>
      </main>
      {step === 'create' ? (
        <Dialog
          title="Create group"
          onClose={() => setStep('idle')}
          restoreFocusRef={stableTrigger ? triggerRef : undefined}
        >
          <button type="button" onClick={() => setStep('invite')}>
            Create
          </button>
        </Dialog>
      ) : null}
      {step === 'invite' ? (
        <Dialog
          title="Invite members"
          onClose={() => setStep('idle')}
          restoreFocusRef={stableTrigger ? triggerRef : undefined}
        >
          <button type="button">Done</button>
        </Dialog>
      ) : null}
    </>
  );
}

test('restores the originating trigger across a dialog handoff', async () => {
  const user = userEvent.setup();
  render(<HandoffFixture stableTrigger />);

  const trigger = screen.getByRole('button', { name: 'New group portfolio' });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Create' }));

  expect(screen.getByRole('dialog', { name: 'Invite members' })).toBeInTheDocument();

  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(trigger).toHaveFocus();
});

test('falls back to a deliberate destination when the opener is gone', async () => {
  const user = userEvent.setup();
  render(<HandoffFixture stableTrigger={false} />);

  await user.click(screen.getByRole('button', { name: 'New group portfolio' }));
  await user.click(screen.getByRole('button', { name: 'Create' }));
  await user.keyboard('{Escape}');

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  // Without a stable trigger the captured opener died with the first dialog —
  // focus still must not be dropped on <body>.
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement?.tagName).toBe('MAIN');
});
