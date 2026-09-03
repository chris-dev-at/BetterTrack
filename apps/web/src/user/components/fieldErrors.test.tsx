import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, test } from 'vitest';

import { useFieldErrors } from './fieldErrors';

/**
 * A minimal form over the hook: the "code" box only exists while `showCode` is
 * true, which is the shape every conditional field in the app has (a mode read
 * once at mount, a step of a wizard). Blaming a field that is not rendered must
 * not swallow the failure.
 */
function Harness({ showCode }: { showCode: boolean }) {
  const { formRef, alertRef, fieldError, formError, fail } = useFieldErrors<'code'>();
  const [value, setValue] = useState('');
  const error = fieldError('code');

  return (
    <>
      {formError ? (
        <div ref={alertRef} role="alert" tabIndex={-1}>
          {formError}
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          fail('code', 'That code is not valid.');
        }}
        ref={formRef}
      >
        {showCode ? (
          <>
            <label htmlFor="code">Code</label>
            <input
              aria-describedby={error ? 'code-error' : undefined}
              aria-invalid={error !== undefined || undefined}
              id="code"
              onChange={(e) => setValue(e.target.value)}
              value={value}
            />
            {error ? <span id="code-error">{error}</span> : null}
          </>
        ) : null}
        <button type="submit">Submit</button>
      </form>
    </>
  );
}

test('a blamed field that is on screen owns the failure and takes focus', async () => {
  const u = userEvent.setup();
  render(<Harness showCode />);

  await u.click(screen.getByRole('button', { name: 'Submit' }));

  const field = screen.getByLabelText('Code');
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription('That code is not valid.');
  expect(field).toHaveFocus();
  // Field-owned, so it is NOT duplicated into the form-level alert.
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a blamed field that is not rendered falls back to the form-level alert', async () => {
  const u = userEvent.setup();
  render(<Harness showCode={false} />);

  await u.click(screen.getByRole('button', { name: 'Submit' }));

  // Fail-safe: the message would otherwise render nowhere at all.
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('That code is not valid.');
  expect(alert).toHaveFocus();
});
