import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { LocalNav } from './LocalNav';

const ITEMS = [
  { to: '/portfolio', label: 'Overview', end: true },
  { to: '/portfolio/holdings', label: 'Holdings' },
  { to: '/portfolio/cash', label: 'Cash' },
] as const;

function renderNav(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/portfolio/*" element={<LocalNav items={ITEMS} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('LocalNav', () => {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');

  afterEach(() => {
    if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  describe('with scrollIntoView available', () => {
    let scrollIntoView: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      scrollIntoView = vi.fn();
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });
    });

    test('scrolls the active tab into view on mount, horizontally only', () => {
      renderNav('/portfolio/holdings');

      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      // `block: 'nearest'` is what keeps the page from scrolling vertically.
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
      // The call lands on the active tab, not the strip or a sibling.
      expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByRole('link', { name: 'Holdings' }));
    });

    test('scrolls again on a route change, not only on first mount', async () => {
      const user = userEvent.setup();
      renderNav('/portfolio/holdings');
      expect(scrollIntoView).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole('link', { name: 'Cash' }));

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.mock.contexts[1]).toBe(screen.getByRole('link', { name: 'Cash' }));
    });
  });

  test('does not crash where scrollIntoView is undefined', () => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;

    expect(() => renderNav('/portfolio/holdings')).not.toThrow();
    expect(screen.getByRole('link', { name: 'Holdings' })).toHaveAttribute('aria-current', 'page');
  });
});
