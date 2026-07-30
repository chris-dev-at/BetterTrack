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
