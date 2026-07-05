import { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PinInput } from './PinInput';

/** Thin controlled wrapper so tests can drive `value` like a real caller would. */
function Harness({ length = 4 }: { length?: number }) {
  const [value, setValue] = useState('');
  return <PinInput label="PIN" length={length} value={value} onChange={setValue} />;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PinInput', () => {
  test('renders one box per digit of the configured length', () => {
    render(<Harness length={6} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  test('typing auto-advances focus to the next box', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('PIN'), '42');

    expect(screen.getByLabelText('PIN')).toHaveValue('4');
    expect(document.activeElement).toBe(screen.getByLabelText('PIN digit 3'));
  });

  test('backspace on an empty box moves back and clears the previous digit', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('PIN digit 2'), { target: { value: '2' } });

    // Box 3 is empty; backspace there should clear box 2 and move focus back.
    fireEvent.keyDown(screen.getByLabelText('PIN digit 3'), { key: 'Backspace' });

    expect(document.activeElement).toBe(screen.getByLabelText('PIN digit 2'));
    expect(screen.getByLabelText('PIN')).toHaveValue('4');
  });

  test('pasting a full PIN distributes it across the boxes', () => {
    render(<Harness />);

    fireEvent.paste(screen.getByLabelText('PIN'), {
      clipboardData: { getData: () => '4242' },
    });

    expect(screen.getByLabelText('PIN')).toHaveValue('4');
    expect(screen.getByLabelText('PIN digit 2')).toHaveValue('2');
    expect(screen.getByLabelText('PIN digit 3')).toHaveValue('4');
    expect(screen.getByLabelText('PIN digit 4')).toHaveValue('2');
  });

  test('a digit shows briefly then masks to a dot', () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4' } });
    expect(screen.getByLabelText('PIN')).toHaveValue('4');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByLabelText('PIN')).toHaveValue('•');
  });

  test('no box is a password field, password-ish name/id, or autofill-permissive', () => {
    render(<Harness />);

    for (const box of screen.getAllByRole('textbox')) {
      expect(box).not.toHaveAttribute('type', 'password');
      expect(box.getAttribute('id') ?? '').not.toMatch(/password/i);
      expect(box.getAttribute('name') ?? '').not.toMatch(/password/i);
      expect(box).toHaveAttribute('autocomplete', 'off');
      expect(box).toHaveAttribute('inputmode', 'numeric');
      expect(box).toHaveAttribute('pattern', '[0-9]*');
    }
  });
});
