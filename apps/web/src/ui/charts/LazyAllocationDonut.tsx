import { lazy, Suspense } from 'react';

import { Skeleton } from '../Skeleton';
import type { AllocationDonutProps } from './AllocationDonut';

const AllocationDonutImplementation = lazy(() =>
  import('./AllocationDonut').then((module) => ({ default: module.AllocationDonut })),
);

/** Load Recharts only when an allocation visualization actually mounts. */
export function AllocationDonut(props: AllocationDonutProps) {
  return (
    <Suspense fallback={<Skeleton className="rounded-full" height="h-48" width="w-48" />}>
      <AllocationDonutImplementation {...props} />
    </Suspense>
  );
}
