import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Alert, AuthCard, TextField } from './ui';

test('AuthCard provides one page heading inside its main landmark', () => {
  render(
    <AuthCard subtitle="Sign in to your account">
      <form aria-label="Sign in" />
    </AuthCard>,
  );

  expect(screen.getByRole('main')).toBeInTheDocument();
  expect(
    screen.getAllByRole('heading', { level: 1, name: 'Sign in to your account' }),
  ).toHaveLength(1);
});

test('TextField associates its hint and error with the input', () => {
  render(
    <TextField
      error="Enter a valid email address."
      hint="We use this to sign you in."
      label="Email"
      name="email"
    />,
  );

  const input = screen.getByLabelText('Email');
  const hint = screen.getByText('We use this to sign you in.');
  const error = screen.getByRole('alert');
  const describedBy = input.getAttribute('aria-describedby')?.split(' ');

  expect(hint).toHaveAttribute('id', 'email-hint');
  expect(error).toHaveAttribute('id', 'email-error');
  expect(describedBy).toEqual(['email-hint', 'email-error']);
  expect(describedBy?.map((id) => document.getElementById(id)?.textContent)).toEqual([
    'We use this to sign you in.',
    'Enter a valid email address.',
  ]);
  expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('TextField only marks the input invalid when an error is supplied', () => {
  const { rerender } = render(
    <TextField
      error="Enter a valid email address."
      hint="We use this to sign you in."
      label="Email"
    />,
  );

  rerender(<TextField hint="We use this to sign you in." label="Email" />);

  const input = screen.getByLabelText('Email');
  expect(input).not.toHaveAttribute('aria-invalid');
  expect(input).toHaveAttribute('aria-describedby', 'email-hint');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('Alert reserves assertive semantics for errors and announces success politely', () => {
  render(
    <>
      <Alert tone="success">Vault ready</Alert>
      <Alert tone="info">Vault notice</Alert>
      <Alert tone="error">Vault failed</Alert>
    </>,
  );

  expect(screen.getByRole('status')).toHaveTextContent('Vault ready');
  expect(screen.getAllByRole('alert').map((alert) => alert.textContent)).toEqual([
    'Vault notice',
    'Vault failed',
  ]);
});
