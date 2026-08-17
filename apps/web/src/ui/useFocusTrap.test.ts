import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test } from 'vitest';

import { useFocusTrap } from './useFocusTrap';

function TrapFixture() {
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>();
  return createElement(
    'div',
    { ref: containerRef, onKeyDown, tabIndex: -1 },
    createElement('button', { disabled: true }, 'Disabled'),
    createElement('div', { hidden: true }, createElement('button', null, 'Hidden')),
    createElement('div', { inert: true }, createElement('button', null, 'Inert')),
    createElement('button', null, 'Available'),
  );
}

function InnerTrapFixture() {
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>();
  return createElement(
    'div',
    { ref: containerRef, onKeyDown, tabIndex: -1 },
    createElement('button', null, 'Inner first'),
    createElement('button', null, 'Inner second'),
  );
}

function NestedTrapFixture() {
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>();
  return createElement(
    'div',
    { ref: containerRef, onKeyDown, tabIndex: -1 },
    createElement('button', null, 'Outer first'),
    createElement(InnerTrapFixture),
    createElement('button', null, 'Outer last'),
  );
}

test('focuses only available descendants, contains Tab, and restores the opener', async () => {
  const user = userEvent.setup();
  const opener = document.createElement('button');
  opener.textContent = 'Open';
  document.body.append(opener);
  opener.focus();

  const { unmount } = render(createElement(TrapFixture));
  const available = screen.getByRole('button', { name: 'Available' });

  expect(available).toHaveFocus();
  await user.tab();
  expect(available).toHaveFocus();
  await user.tab({ shift: true });
  expect(available).toHaveFocus();

  unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

function InertBackgroundFixture() {
  const { containerRef, onKeyDown } = useFocusTrap<HTMLDivElement>({ inertBackground: true });
  return createElement(
    'div',
    { ref: containerRef, onKeyDown, tabIndex: -1 },
    createElement('button', null, 'Overlay control'),
  );
}

test('the background stays inert until the last sibling overlay releases it', () => {
  // Two overlays that are DOM siblings, not nested — a dialog and the palette
  // above it, both portalled to <body> — inert the very same background.
  const page = document.createElement('div');
  page.append(document.createElement('button'));
  const appOwned = document.createElement('div');
  appOwned.setAttribute('inert', '');
  document.body.append(page, appOwned);

  const first = render(createElement(InertBackgroundFixture));
  expect(page).toHaveAttribute('inert');

  const second = render(createElement(InertBackgroundFixture));
  expect(page).toHaveAttribute('inert');

  // The first one closes while the second is still open: dropping the attribute
  // here would bring the page live underneath it.
  first.unmount();
  expect(page).toHaveAttribute('inert');

  second.unmount();
  expect(page).not.toHaveAttribute('inert');
  // Inertness the app owns is never counted, so it is never taken away.
  expect(appOwned).toHaveAttribute('inert');

  page.remove();
  appOwned.remove();
});

test('handles each Tab once when focus traps are nested', async () => {
  const user = userEvent.setup();
  render(createElement(NestedTrapFixture));

  const innerFirst = screen.getByRole('button', { name: 'Inner first' });
  const innerSecond = screen.getByRole('button', { name: 'Inner second' });
  innerFirst.focus();

  await user.tab();
  expect(innerSecond).toHaveFocus();
  await user.tab();
  expect(innerFirst).toHaveFocus();
  await user.tab({ shift: true });
  expect(innerSecond).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outer first' })).not.toHaveFocus();
  expect(screen.getByRole('button', { name: 'Outer last' })).not.toHaveFocus();
});
