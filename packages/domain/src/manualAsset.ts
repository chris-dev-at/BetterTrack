/** One sparse custom-asset value mark on an ISO calendar day. */
export interface ManualAssetValueMark {
  date: string;
  value: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Expand sparse custom-asset marks into one linearly interpolated point per
 * calendar day between marks. The original endpoints remain exact and days
 * outside the first/last mark stay absent for the caller's carry-forward rule.
 */
export function interpolateDailyMarks(
  points: readonly ManualAssetValueMark[],
): ManualAssetValueMark[] {
  if (points.length <= 1) return points.map((point) => ({ ...point }));

  const result: ManualAssetValueMark[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const left = points[index]!;
    const right = points[index + 1]!;
    const leftMs = Date.parse(`${left.date}T00:00:00.000Z`);
    const rightMs = Date.parse(`${right.date}T00:00:00.000Z`);
    const spanDays = Math.round((rightMs - leftMs) / MS_PER_DAY);

    result.push({ ...left });
    for (let offset = 1; offset < spanDays; offset += 1) {
      result.push({
        date: new Date(leftMs + offset * MS_PER_DAY).toISOString().slice(0, 10),
        value: left.value + ((right.value - left.value) * offset) / spanDays,
      });
    }
  }
  result.push({ ...points[points.length - 1]! });
  return result;
}
