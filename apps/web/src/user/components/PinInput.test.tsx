import { useState } from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PinInput } from './PinInput';

/** Thin controlled wrapper so tests can drive `value` like a real caller would. */
function Harness({
  length = 4,
  onComplete,
}: {
  length?: number;
  onComplete?: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <PinInput
      label="PIN"
      length={length}
      value={value}
      onChange={setValue}
      onComplete={onComplete}
    />
  );
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

  test('a digit shows briefly then masks — but the value stays the real digit (#288)', () => {
    vi.useFakeTimers();
    render(<Harness />);

    const box = screen.getByLabelText('PIN');
    fireEvent.change(box, { target: { value: '4' } });
    expect(box).toHaveValue('4');
    expect(box).not.toHaveAttribute('data-masked');

    act(() => {
      vi.advanceTimersByTime(600);
    });
    // Masking is visual only: the box carries a `data-masked` marker but its
    // value is never a non-digit glyph, so numeric validation still passes.
    expect(box).toHaveValue('4');
    expect(box).toHaveAttribute('data-masked', 'true');
  });

  test('onComplete fires with the real digits once the last box is filled (#288)', () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('PIN digit 2'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('PIN digit 3'), { target: { value: '4' } });
    expect(onComplete).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('PIN digit 4'), { target: { value: '2' } });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('4242');
  });

  test('every box submits a real digit — never a mask glyph — as its value (#288)', () => {
    vi.useFakeTimers();
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('PIN digit 2'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('PIN digit 3'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('PIN digit 4'), { target: { value: '4' } });

    // Let every reveal timer lapse so all four boxes are in their masked state.
    act(() => {
      vi.advanceTimersByTime(600);
    });

    for (const box of screen.getAllByRole('textbox')) {
      expect(box.getAttribute('value') ?? (box as HTMLInputElement).value).toMatch(/^[0-9]$/);
    }
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
