import { render, screen } from '@testing-library/react';
import { expect, test } from 'vitest';

import { Badge, Button, EmptyState, PageHeader, TextField } from './ui';

test('admin content primitives share the compact tokenized grammar', () => {
  render(
    <>
      <PageHeader description="Operational controls" title="Console" />
      <Button>Save</Button>
      <Badge tone="green">Healthy</Badge>
      <EmptyState>No results</EmptyState>
    </>,
  );

  expect(screen.getByRole('heading', { name: 'Console' })).toHaveClass('bt-admin-page-head__title');
  expect(screen.getByRole('button', { name: 'Save' })).toHaveClass(
    'bt-admin-btn',
    'bt-admin-btn--primary',
  );
  expect(screen.getByText('Healthy')).toHaveClass('bt-admin-badge', 'bt-admin-badge--green');
  expect(screen.getByText('No results')).toHaveClass('bt-admin-empty');
});

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
