import { useState } from 'react';

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import { PinInput } from './PinInput';

const MASK = '•';

/** Thin controlled wrapper so tests can drive `value` like a real caller would. */
function Harness({
  length = 4,
  onComplete,
  onChange,
}: {
  length?: number;
  onComplete?: (value: string) => void;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <PinInput
      label="PIN"
      length={length}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
      onComplete={onComplete}
    />
  );
}

describe('PinInput', () => {
  test('renders one box per digit of the configured length', () => {
    render(<Harness length={6} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  test('typing auto-advances focus to the next box', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.type(screen.getByLabelText('PIN'), '42');

    // The first box carries the mask glyph — never the typed digit (V4-P0).
    expect(screen.getByLabelText('PIN')).toHaveValue(MASK);
    expect(document.activeElement).toBe(screen.getByLabelText('PIN digit 3'));
  });

  test('backspace on an empty box moves back and clears the previous digit', () => {
    render(<Harness />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('PIN digit 2'), { target: { value: '2' } });

    // Box 3 is empty; backspace there should clear box 2 and move focus back.
    fireEvent.keyDown(screen.getByLabelText('PIN digit 3'), { key: 'Backspace' });

    expect(document.activeElement).toBe(screen.getByLabelText('PIN digit 2'));
    // First box still holds a digit (in parent state) — DOM value is the mask.
    expect(screen.getByLabelText('PIN')).toHaveValue(MASK);
    // Second box was cleared — DOM value is empty.
    expect(screen.getByLabelText('PIN digit 2')).toHaveValue('');
  });

  test('pasting a full PIN distributes it across the boxes — masked in the DOM', () => {
    render(<Harness />);

    fireEvent.paste(screen.getByLabelText('PIN'), {
      clipboardData: { getData: () => '4242' },
    });

    // Every box shows the mask glyph; a raw digit never appears in the DOM.
    for (const box of screen.getAllByRole('textbox') as HTMLInputElement[]) {
      expect(box).toHaveValue(MASK);
    }
  });

  test('the DOM never contains a typed PIN digit — masked dots only (V4-P0 (a))', () => {
    render(<Harness />);

    // Type each digit into its own box and check the DOM after every keystroke:
    // no box's value ever matches /[0-9]/ (masked-dots-only, no flash window).
    const labels = ['PIN', 'PIN digit 2', 'PIN digit 3', 'PIN digit 4'];
    for (let i = 0; i < labels.length; i += 1) {
      fireEvent.change(screen.getByLabelText(labels[i] as string), {
        target: { value: String(i + 1) },
      });
      for (const box of screen.getAllByRole('textbox') as HTMLInputElement[]) {
        expect(box.value).not.toMatch(/[0-9]/);
      }
    }
  });

  test('onComplete fires with the real digits — from parent state, not DOM value (#288)', () => {
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

  test('the parent controller sees the real PIN even though the DOM masks it', () => {
    const onChange = vi.fn<(value: string) => void>();
    render(<Harness onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('PIN'), { target: { value: '4' } });
    fireEvent.change(screen.getByLabelText('PIN digit 2'), { target: { value: '2' } });

    // Parent state received the real digits — that's what a submit consumes.
    expect(onChange).toHaveBeenLastCalledWith('42');
  });

  test('no box is a password field, password-ish name/id, or autofill-permissive', () => {
    render(<Harness />);

    for (const box of screen.getAllByRole('textbox')) {
      expect(box).not.toHaveAttribute('type', 'password');
      expect(box.getAttribute('id') ?? '').not.toMatch(/password/i);
      expect(box.getAttribute('name') ?? '').not.toMatch(/password/i);
      expect(box).toHaveAttribute('autocomplete', 'off');
      expect(box).toHaveAttribute('inputmode', 'numeric');
      // No `pattern="[0-9]*"` — a mask-glyph value must not fail native
      // numeric validation on submit (V4-P0 supersedes the #288 in-value fix).
      expect(box).not.toHaveAttribute('pattern');
    }
  });
});
