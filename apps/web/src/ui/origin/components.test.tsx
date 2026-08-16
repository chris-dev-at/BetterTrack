import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import {
  ChartFrame,
  DataList,
  DataRow,
  Drawer,
  Field,
  Input,
  ODialog,
  Page,
  StatePanel,
  Surface,
  SurfaceBody,
  SurfaceHead,
} from './components';

test('content primitives compose one connected, semantic page surface', () => {
  render(
    <Page aria-label="Portfolio overview" width="wide">
      <Surface>
        <SurfaceHead sub="Across every account" title="Holdings" />
        <SurfaceBody flush>
          <DataList>
            <DataRow>
              <span>Alphabet</span>
              <span className="bt-data-row__meta">+3.2%</span>
            </DataRow>
          </DataList>
        </SurfaceBody>
      </Surface>
      <ChartFrame caption="Month to date" title="Performance">
        <div>plot</div>
      </ChartFrame>
    </Page>,
  );

  expect(screen.getByLabelText('Portfolio overview')).toHaveClass('bt-page', 'bt-page--wide');
  expect(screen.getByRole('list')).toContainElement(screen.getByRole('listitem'));
  expect(screen.getByRole('figure')).toHaveTextContent('PerformanceplotMonth to date');
});

test('StatePanel exposes loading and error announcements without changing its hierarchy', () => {
  const { rerender } = render(
    <StatePanel kind="loading" title="Loading positions">
      This may take a moment.
    </StatePanel>,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Loading positionsThis may take a moment.');

  rerender(
    <StatePanel kind="error" title="Positions unavailable">
      Try again.
    </StatePanel>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Positions unavailableTry again.');
});

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
  expect(close).toHaveFocus();
  expect(opener.closest('[inert]')).not.toBeNull();
  expect(behind.closest('[inert]')).not.toBeNull();
  expect(dialog.closest('[inert]')).toBeNull();

  save.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(save).toHaveFocus();

  await user.click(close);
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
  expect(drawer).toHaveAttribute('aria-modal', 'true');
  expect(close).toHaveFocus();
  expect(opener.closest('[inert]')).not.toBeNull();
  expect(behind.closest('[inert]')).not.toBeNull();
  expect(drawer.closest('[inert]')).toBeNull();

  last.focus();
  await user.tab();
  expect(close).toHaveFocus();
  await user.tab({ shift: true });
  expect(last).toHaveFocus();

  await user.click(close);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
  expect(opener.closest('[inert]')).toBeNull();
});
