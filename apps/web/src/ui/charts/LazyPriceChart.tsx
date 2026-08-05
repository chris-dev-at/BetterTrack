import { lazy, Suspense } from 'react';

import { Skeleton } from '../Skeleton';
import type { PriceChartProps } from './PriceChart';

const PriceChartImplementation = lazy(() =>
  import('./PriceChart').then((module) => ({ default: module.PriceChart })),
);

/** Load the canvas chart runtime only when a price chart actually mounts. */
export function PriceChart(props: PriceChartProps) {
  return (
    <Suspense fallback={<Skeleton className="rounded-md" height="h-full" width="w-full" />}>
      <PriceChartImplementation {...props} />
    </Suspense>
  );
}
