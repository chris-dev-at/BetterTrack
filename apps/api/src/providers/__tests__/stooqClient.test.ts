import { describe, expect, it, vi } from 'vitest';

import { createStooqClient } from '../stooqClient';

/**
 * Stooq client CSV parsing (§13.5 V5-P1c) against RECORDED fixtures — no live
 * network. The fixtures are the exact CSV shapes Stooq returns for its light
 * quote (`/q/l/`) and daily history (`/q/d/l/`) endpoints, including the `N/D`
 * unknown-symbol sentinel and the `No data` empty history.
 */

// Recorded Stooq light-quote CSV (f=sd2t2ohlcv).
const QUOTE_CSV =
  'Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-07-16,22:00:04,207.5,210.1,206.9,209.05,48210000\n';
const QUOTE_ND_CSV =
  'Symbol,Date,Time,Open,High,Low,Close,Volume\nNOPE.US,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n';
// Recorded Stooq daily-history CSV.
const HISTORY_CSV =
  'Date,Open,High,Low,Close,Volume\n2026-07-14,205.1,206.0,203.2,205.8,41000000\n2026-07-15,206.0,208.4,205.5,207.9,39000000\n';
const HISTORY_EMPTY = 'No data\n';

function clientWith(body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
  return {
    client: createStooqClient({ fetch: fetchMock as unknown as typeof fetch }),
    fetchMock,
  };
}

describe('createStooqClient.quote', () => {
  it('parses a light-quote row (close + date/time)', async () => {
    const { client, fetchMock } = clientWith(QUOTE_CSV);
    const row = await client.quote('aapl.us');
    expect(row).toEqual({
      symbol: 'AAPL.US',
      date: '2026-07-16',
      time: '22:00:04',
      close: 209.05,
    });
    // URL-encodes the symbol and asks for the CSV light quote.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/q/l/?s=aapl.us'));
  });

  it('maps the `N/D` unknown-symbol sentinel to a null close', async () => {
    const { client } = clientWith(QUOTE_ND_CSV);
    const row = await client.quote('nope.us');
    expect(row?.close).toBeNull();
  });

  it('throws with the status code on a non-2xx (transient → breaker owns it)', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    const client = createStooqClient({ fetch: fetchMock as unknown as typeof fetch });
    await expect(client.quote('aapl.us')).rejects.toMatchObject({ code: 503 });
  });
});

describe('createStooqClient.history', () => {
  it('parses daily rows to date+close, ascending', async () => {
    const { client, fetchMock } = clientWith(HISTORY_CSV);
    const rows = await client.history('aapl.us', {
      period1: new Date('2026-07-14T00:00:00Z'),
      period2: new Date('2026-07-16T00:00:00Z'),
    });
    expect(rows).toEqual([
      { date: '2026-07-14', close: 205.8 },
      { date: '2026-07-15', close: 207.9 },
    ]);
    // Formats the window bounds as Stooq's YYYYMMDD.
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('d1=20260714&d2=20260716'));
  });

  it('returns [] for a `No data` body', async () => {
    const { client } = clientWith(HISTORY_EMPTY);
    const rows = await client.history('nope.us', {
      period1: new Date('2026-07-14T00:00:00Z'),
      period2: new Date('2026-07-16T00:00:00Z'),
    });
    expect(rows).toEqual([]);
  });
});
