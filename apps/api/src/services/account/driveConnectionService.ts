import type { CreateDriveConnectionRequest, DriveConnection } from '@bettertrack/contracts';

import type {
  DriveConnectionDeleteResult,
  DriveConnectionRepository,
} from '../../data/repositories/driveConnectionRepository';

export interface DriveConnectionService {
  list(userId: string): Promise<DriveConnection[]>;
  create(userId: string, identity: CreateDriveConnectionRequest): Promise<DriveConnection>;
  touch(userId: string, connectionId: string): Promise<DriveConnection | null>;
  delete(
    userId: string,
    connectionId: string,
    acknowledgeBound: boolean,
  ): Promise<DriveConnectionDeleteResult>;
}

export function createDriveConnectionService(
  repository: DriveConnectionRepository,
  now: () => Date = () => new Date(),
): DriveConnectionService {
  return {
    list: (userId) => repository.list(userId),
    create: (userId, identity) => repository.create(userId, identity, now()),
    touch: (userId, connectionId) => repository.touch(userId, connectionId, now()),
    delete: (userId, connectionId, acknowledgeBound) =>
      repository.delete(userId, connectionId, acknowledgeBound, now()),
  };
}
