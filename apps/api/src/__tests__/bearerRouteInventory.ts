import type { MountedSurface } from '../scripts/checkOpenapiCoverage';

const API_PREFIX = '/api/v1';

export const BEARER_ALL_METHODS_ROUTE_METHOD = '<all-methods>';
export const BEARER_OPAQUE_MOUNT_METHOD = '<opaque-mount>';

export interface BearerInventoryRoute {
  method: string;
  path: string;
}

function assertNever(surface: never): never {
  throw new Error(`Unknown mounted bearer surface: ${JSON.stringify(surface)}`);
}

/**
 * Normalize every route-table surface under one bearer-policy mount. Synthetic
 * methods deliberately cannot match a normal HTTP allowlist entry, so adding
 * router.all(...) or an opaque router.use(...) leaf makes the completeness
 * equality fail closed instead of silently disappearing from the inventory.
 */
export function mountedBearerRouteInventory(
  surfaces: readonly MountedSurface[],
  modulePath: `/${string}`,
): BearerInventoryRoute[] {
  const mountedPrefix = `${API_PREFIX}${modulePath}`;

  return surfaces.flatMap((surface) => {
    if (surface.path !== mountedPrefix && !surface.path.startsWith(`${mountedPrefix}/`)) {
      return [];
    }

    const path = surface.path.slice(API_PREFIX.length) || '/';
    switch (surface.kind) {
      case 'route':
        return [{ method: surface.method, path }];
      case 'all-methods-route':
        return [{ method: BEARER_ALL_METHODS_ROUTE_METHOD, path }];
      case 'opaque-mount':
        return [
          {
            method: `${BEARER_OPAQUE_MOUNT_METHOD}:${surface.handler}[${surface.occurrence}]`,
            path,
          },
        ];
      default:
        return assertNever(surface);
    }
  });
}
