import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test } from 'vitest';

import type { PortfolioForkProvenance, PortfolioMirrorBadge } from '@bettertrack/contracts';

import { I18nProvider } from '../../i18n';
import {
  MirrorAttributionChip,
  MirrorAvatarStack,
  MirrorForkProvenanceLine,
} from './MirrorchainPanel';

/**
 * MIRRORCHAIN M5 — the presentational surface (design §11 avatar stack, §6 fork
 * provenance, §10 attribution chip). These are the byte-identical anchors the
 * issue's acceptance test cares about: the stack + fork line render EXACTLY on
 * their gating field and nothing else, and the attribution chip renders the
 * expected label. Behavioral / mutation flows live in the API tests
 * (`mirrorM5.test.ts`) — this file guards the render gates.
 */

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <I18nProvider>{node}</I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('MirrorchainPanel — avatar stack', () => {
  test('renders the chain name + member count when synced', () => {
    const badge: PortfolioMirrorBadge = {
      chainId: '00000000-0000-4000-8000-000000000001',
      chainName: 'Family',
      role: 'member',
      memberCount: 3,
      sync: { appliedSeq: 42, lastSeq: 42, percent: 100, synced: true },
    };
    wrap(<MirrorAvatarStack badge={badge} onClick={() => {}} />);
    expect(screen.getByText('Family')).toBeInTheDocument();
    expect(screen.getByText('3 members')).toBeInTheDocument();
  });

  test('shows the syncing progress while a copy is behind', () => {
    const badge: PortfolioMirrorBadge = {
      chainId: '00000000-0000-4000-8000-000000000002',
      chainName: 'Family',
      role: 'member',
      memberCount: 2,
      sync: { appliedSeq: 30, lastSeq: 100, percent: 30, synced: false },
    };
    wrap(<MirrorAvatarStack badge={badge} onClick={() => {}} />);
    expect(screen.getByText('Syncing… 30 %')).toBeInTheDocument();
  });
});

describe('MirrorchainPanel — fork provenance line (design §6)', () => {
  test('renders "Forked from ⟨chain⟩ · ⟨date⟩" from the membership tombstone', () => {
    const fork: PortfolioForkProvenance = {
      chainId: '00000000-0000-4000-8000-000000000003',
      chainName: 'Roommates',
      endedAt: '2026-01-15T12:00:00.000Z',
    };
    wrap(<MirrorForkProvenanceLine fork={fork} />);
    // Date formatting is locale-driven — assert the chain name + the "Forked
    // from" label prefix are both present.
    expect(screen.getByText(/Forked from/)).toHaveTextContent('Roommates');
  });
});

describe('MirrorchainPanel — attribution chip (design §10)', () => {
  test('renders the member username as the actor', () => {
    wrap(<MirrorAttributionChip attribution={{ username: 'alice', profileIcon: null }} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
  });
});
