import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { updatePortfolio } from '../../lib/portfolioApi';
import { listMyShared } from '../../lib/socialApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button } from '../components/ui';

const MY_SHARED_STALE_MS = 30_000;

/**
 * My Shared Items (PROJECTPLAN.md §6.9 point 5) — the caller's own
 * `visibility=friends` portfolios with a quick toggle-off back to `private`.
 */
export function MySharedItemsPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['social', 'my-shared'],
    queryFn: ({ signal }) => listMyShared(signal),
    staleTime: MY_SHARED_STALE_MS,
  });

  const toggleOffMutation = useMutation({
    mutationFn: (portfolioId: string) => updatePortfolio(portfolioId, { visibility: 'private' }),
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['social', 'my-shared'] });
    },
    onError: () => setActionError('Could not stop sharing that portfolio. Please try again.'),
  });

  if (isLoading) {
    return (
      <section className="flex flex-col gap-3">
        <Skeleton height="h-6" width="w-48" />
        <Skeleton height="h-16" />
      </section>
    );
  }

  if (isError || !data) {
    return <Alert tone="error">Could not load your shared items. Please refresh the page.</Alert>;
  }

  if (data.portfolios.length === 0) {
    return (
      <EmptyState
        title="You're not sharing anything"
        description="Turn sharing on for a portfolio in Settings → Account to have it appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {actionError ? <Alert tone="error">{actionError}</Alert> : null}
      <ul className="divide-y divide-neutral-800">
        {data.portfolios.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 py-3">
            <span className="text-sm font-medium text-neutral-100">{p.name}</span>
            <Button
              variant="secondary"
              onClick={() => toggleOffMutation.mutate(p.id)}
              disabled={toggleOffMutation.isPending && toggleOffMutation.variables === p.id}
            >
              {toggleOffMutation.isPending && toggleOffMutation.variables === p.id
                ? 'Stopping…'
                : 'Stop sharing'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
