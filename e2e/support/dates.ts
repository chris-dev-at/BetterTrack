const DAY_MS = 24 * 60 * 60 * 1_000;

function viennaToday(now: Date): { epochMs: number } {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Vienna',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)!.value);
  const year = part('year');
  return { epochMs: Date.UTC(year, part('month') - 1, part('day')) };
}

/**
 * Return `count` ascending ISO booking days ending yesterday in Europe/Vienna.
 * Every produced date is before today in Vienna. Tax years are living
 * documentation, so crossing New Year needs no setup request.
 */
export function recentBookingDates(count: number, now = new Date()): string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('Booking-date count must be a positive integer.');
  }

  const today = viennaToday(now);
  return Array.from({ length: count }, (_, index) =>
    new Date(today.epochMs - (count - index) * DAY_MS).toISOString().slice(0, 10),
  );
}
