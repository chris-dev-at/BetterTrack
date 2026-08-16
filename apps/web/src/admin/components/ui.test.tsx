import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { TextField } from './ui';

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
