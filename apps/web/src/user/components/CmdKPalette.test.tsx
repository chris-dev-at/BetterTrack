import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../lib/searchApi');
import { CmdKPalette } from './CmdKPalette';

function renderPalette(props: { isOpen: boolean; onClose?: () => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = props.onClose ?? vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CmdKPalette isOpen={props.isOpen} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CmdKPalette', () => {
  test('is not rendered when closed', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('is rendered when open', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByRole('dialog', { name: /quick search/i })).toBeInTheDocument();
  });

  test('contains the asset search input when open', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByRole('searchbox', { name: /search assets/i })).toBeInTheDocument();
  });

  test('calls onClose when Escape is pressed', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
  });

  test('calls onClose when backdrop is clicked', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    // The backdrop is the dialog element itself (the outermost div with role="dialog")
    await user.click(screen.getByRole('dialog', { name: /quick search/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  test('does not call onClose when clicking inside the dialog panel', async () => {
    const user = userEvent.setup();
    const { onClose } = renderPalette({ isOpen: true });

    // Click the search input — inside the panel, not the backdrop
    await user.click(screen.getByRole('searchbox'));

    expect(onClose).not.toHaveBeenCalled();
  });

  test('shows the Esc hint', () => {
    renderPalette({ isOpen: true });
    expect(screen.getByText(/esc/i)).toBeInTheDocument();
  });
});

describe('⌘K / Ctrl-K shortcut (AppLayout integration)', () => {
  test('the palette component does not self-open (open state is owned by the parent)', () => {
    renderPalette({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
