import { afterEach, describe, expect, it, vi } from 'vitest';

import { listNotifications } from './notificationsApi';

vi.mock('./apiClient', () => ({ apiRequest: vi.fn() }));

const { apiRequest } = await import('./apiClient');
const apiRequestMock = vi.mocked(apiRequest);

afterEach(() => {
  vi.resetAllMocks();
});

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: '018f0000-0000-7000-8000-000000000001',
    type: 'friend.request',
    title: 'New friend request',
    body: 'anna sent you a friend request.',
    payload: null as unknown,
    readAt: null,
    archivedAt: null,
    createdAt: '2026-08-06T09:00:00.000Z',
    ...overrides,
  };
}

describe('listNotifications payload tolerance (#1138)', () => {
  it('keeps a readable message descriptor as-is', async () => {
    apiRequestMock.mockResolvedValue({
      items: [
        row({
          payload: {
            eventKey: 'friend.request:req-1',
            requestId: 'req-1',
            message: { key: 'friendRequest', params: { actor: 'anna' } },
          },
        }),
      ],
      nextCursor: null,
      unreadCount: 1,
    });

    const page = await listNotifications();
    expect(page.items[0]?.payload).toEqual({
      eventKey: 'friend.request:req-1',
      requestId: 'req-1',
      message: { key: 'friendRequest', params: { actor: 'anna' } },
    });
  });

  it('drops an unreadable descriptor instead of rejecting the whole inbox', async () => {
    // The hazard this guards: a tab on an older build meets a row written by a
    // newer worker (key outside this build's enum). Parsing the response as-is
    // would throw and blank the ENTIRE list — the row must simply fall back to
    // its persisted title/body while keeping eventKey and the deep-link id.
    apiRequestMock.mockResolvedValue({
      items: [
        row({
          payload: {
            eventKey: 'friend.request:req-1',
            requestId: 'req-1',
            message: { key: 'keyFromANewerServer', params: { actor: 'anna' } },
          },
        }),
        row({ id: '018f0000-0000-7000-8000-000000000002', title: 'Legacy row' }),
      ],
      nextCursor: null,
      unreadCount: 2,
    });

    const page = await listNotifications();
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.payload).toEqual({
      eventKey: 'friend.request:req-1',
      requestId: 'req-1',
    });
    expect(page.items[0]?.title).toBe('New friend request');
    expect(page.items[1]?.payload).toBeNull();
  });
});
