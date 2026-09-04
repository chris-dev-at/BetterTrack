import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { KeyValueList, PageHeader, TextField } from './ui';

test('TextField associates its hint and error with the input', () => {
  render(
    <TextField
      error="Enter a valid email address."
      hint="Use your administrator email address."
      label="Email"
      name="email"
    />,
  );

  const input = screen.getByLabelText('Email');
  const hint = screen.getByText('Use your administrator email address.');
  const error = screen.getByRole('alert');
  const describedBy = input.getAttribute('aria-describedby')?.split(' ');

  expect(hint).toHaveAttribute('id', 'email-hint');
  expect(error).toHaveAttribute('id', 'email-error');
  expect(describedBy).toEqual(['email-hint', 'email-error']);
  expect(describedBy?.map((id) => document.getElementById(id)?.textContent)).toEqual([
    'Use your administrator email address.',
    'Enter a valid email address.',
  ]);
  expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('TextField keeps a required marker out of its accessible label', () => {
  const { container } = render(<TextField label="Administrator email" required type="email" />);

  expect(screen.getByLabelText('Administrator email', { exact: true })).toHaveAttribute('required');
  const marker = container.querySelector<HTMLElement>('.bt-field__required-marker')!;
  expect(marker).toHaveAttribute('aria-hidden', 'true');
  expect(marker).toHaveTextContent('*');
});

test('TextField only marks the input invalid when an error is supplied', () => {
  const { rerender } = render(
    <TextField
      error="Enter a valid email address."
      hint="Use your administrator email address."
      label="Email"
    />,
  );

  rerender(<TextField hint="Use your administrator email address." label="Email" />);

  const input = screen.getByLabelText('Email');
  expect(input).not.toHaveAttribute('aria-invalid');
  expect(input).toHaveAttribute('aria-describedby', 'email-hint');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

/**
 * Both halves of the `/admin/users/:userId` phone overflow (#1756): the page is
 * headed with a username and an email, and its Account panel lists the same
 * values as rows. Neither string has a break opportunity in it, and without
 * `overflow-wrap: anywhere` the first paints past the text column (526px of
 * `h1` in a 328px column) while the second raises the panel's min-content width
 * and, through the grid's `min-width: auto`, the width of the page itself.
 *
 * jsdom does no layout, so the class is the contract it can hold; the rendered
 * boxes are measured by the 390/360 admin sweep in
 * `e2e/mobile-overflow.spec.ts`.
 */
test('PageHeader breaks an unbreakable title and description instead of overflowing', () => {
  const { container } = render(
    <PageHeader
      description="e2e-mobile-overflow-notification-sender-with-long-username@example.com"
      eyebrow="People"
      title="e2emobileoverflownotificationsemtnchkzab"
    />,
  );

  expect(container.querySelector('h1')).toHaveClass('wrap-anywhere');
  expect(screen.getByText(/@example\.com$/)).toHaveClass('wrap-anywhere');
});

test('KeyValueList breaks an unbreakable value instead of widening its panel', () => {
  render(
    <KeyValueList
      rows={[
        { label: 'Email', value: 'e2e-mobile-overflow-notification-sender@example.com' },
        { label: 'Username', value: 'e2emobileoverflownotificationsemtnchkzab' },
      ]}
    />,
  );

  const values = screen.getAllByText(/e2e/);
  expect(values).toHaveLength(2);
  for (const value of values) {
    expect(value.tagName).toBe('DD');
    // `min-w-0` alone only lets the cell shrink — it cannot break a word that
    // refuses to break, and it does not lower the panel's min-content width.
    expect(value).toHaveClass('min-w-0', 'wrap-anywhere');
  }
});
