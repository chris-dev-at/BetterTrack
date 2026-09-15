import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, renderHook, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

vi.mock('../user/vault/usePrivacyMode', () => ({
  useResolvedPrivacyMode: () => 'normal',
}));

import { AddWidgetDrawer } from '../user/home/AddWidgetDrawer';
import { COMMANDS, isCommandConfigured } from '../user/components/commands';
import { useSectionNavChildren } from '../user/components/sectionNav';
import { apiRequest } from './apiClient';
import { useDeployCapabilities, useFeatureEnabled } from './featureFlags';

/** A deployment that HAS market intelligence — the healthy resolved answer. */
const INTEL_ON = {
  flags: { realtime: true, liveMode: true, chat: true, alerts: true, imports: true, ai: true },
  capabilities: { marketIntel: true },
};

/** How many attempts react-query makes before a failing bootstrap is terminal. */
const RETRIES = 2;

function wrapper(retry: number | false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry, retryDelay: 0 } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

const NEWS_COMMAND = COMMANDS.find((command) => command.to === '/assets/news')!;

/** The three surfaces the capability key exists to remove, read as one verdict. */
function offeredDestinations(retry: number | false) {
  const Wrapper = wrapper(retry);
  const nav = renderHook(() => useSectionNavChildren('assets'), { wrapper: Wrapper });
  const capabilities = renderHook(() => useDeployCapabilities(), { wrapper: Wrapper });
  const imports = renderHook(() => useFeatureEnabled('imports'), { wrapper: Wrapper });
  render(<AddWidgetDrawer onAdd={vi.fn()} onClose={vi.fn()} open />, { wrapper: Wrapper });
  return {
    navTabs: () => nav.result.current.map((child) => child.to),
    newsCommandOffered: () => isCommandConfigured(NEWS_COMMAND, capabilities.result.current),
    catalogHas: (label: string) => screen.queryByText(label) !== null,
    importsFlag: () => imports.result.current,
    settle: async () => {
      await nav.rerender();
      await capabilities.rerender();
      await imports.rerender();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bootstrap fallback — capabilities fail closed, flags fail open (§13.5 V5-P5)', () => {
  test('offers no capability-gated destination while the bootstrap is still pending', () => {
    // Never resolves: the first paint, and every paint until the answer lands.
    vi.mocked(apiRequest).mockReturnValue(new Promise(() => {}));
    const app = offeredDestinations(false);

    expect(app.navTabs()).not.toContain('/assets/news');
    expect(app.newsCommandOffered()).toBe(false);
    expect(app.catalogHas('News')).toBe(false);
    expect(app.catalogHas('Dividends')).toBe(false);
    // Ungated neighbours are untouched — this is a gate, not a blank screen.
    expect(app.navTabs()).toContain('/assets/watchlists');
    expect(app.catalogHas('Watchlist')).toBe(true);
  });

  test('offers none of them when the bootstrap errors', async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error('offline'));
    const app = offeredDestinations(false);
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(1));
    await app.settle();

    expect(app.navTabs()).not.toContain('/assets/news');
    expect(app.newsCommandOffered()).toBe(false);
    expect(app.catalogHas('News')).toBe(false);
    expect(app.catalogHas('Dividends')).toBe(false);
  });

  test('offers none of them once the retries are exhausted — the permanent case', async () => {
    vi.mocked(apiRequest).mockRejectedValue(new Error('blocked'));
    const app = offeredDestinations(RETRIES);
    // Terminal state: react-query will not ask again on its own, so whatever the
    // fallback says here is what the deployment advertises from now on.
    await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(RETRIES + 1));
    await app.settle();

    expect(app.navTabs()).not.toContain('/assets/news');
    expect(app.newsCommandOffered()).toBe(false);
    expect(app.catalogHas('News')).toBe(false);
    expect(app.catalogHas('Dividends')).toBe(false);
  });

  test('keeps runtime flags fail-open while the bootstrap is unresolved', () => {
    // Flags are admin toggles over features the deployment does have; hiding
    // them during a blip would blank working surfaces for no gain.
    vi.mocked(apiRequest).mockReturnValue(new Promise(() => {}));
    const app = offeredDestinations(false);

    expect(app.importsFlag()).toBe(true);
    expect(
      renderHook(() => useSectionNavChildren('portfolio'), {
        wrapper: wrapper(false),
      }).result.current.map((child) => child.to),
    ).toContain('/portfolio/import');
  });

  test('every gated destination appears once the bootstrap resolves with the capability', async () => {
    vi.mocked(apiRequest).mockResolvedValue(INTEL_ON);
    const app = offeredDestinations(false);
    await waitFor(() => expect(app.navTabs()).toContain('/assets/news'));
    await app.settle();

    expect(app.newsCommandOffered()).toBe(true);
    await waitFor(() => expect(app.catalogHas('News')).toBe(true));
    expect(app.catalogHas('Dividends')).toBe(true);
  });

  test('a healthy load reveals the gated tab once — it never shows then retracts', async () => {
    vi.mocked(apiRequest).mockResolvedValue(INTEL_ON);
    const Wrapper = wrapper(false);
    const nav = renderHook(() => useSectionNavChildren('assets'), { wrapper: Wrapper });
    // The loading paint must already be free of the tab, so the transition is
    // absent → present, never present → absent → present (a visible flash).
    expect(nav.result.current.map((child) => child.to)).not.toContain('/assets/news');
    await waitFor(() =>
      expect(nav.result.current.map((child) => child.to)).toContain('/assets/news'),
    );
  });
});
