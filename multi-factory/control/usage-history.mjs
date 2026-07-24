import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const USAGE_HISTORY_HOURS = Object.freeze([24, 168, 720]);
export const USAGE_HISTORY_MAX_ENTRIES = 9_000;
export const USAGE_HISTORY_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;
export const USAGE_HISTORY_MIN_SAMPLE_MS = 4 * 60 * 1000;

const fileQueues = new Map();
const percent = (value) => {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
};
const timestamp = (value) => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};
const modelName = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 100 &&
  /^[\x20-\x7e]+$/.test(value)
    ? value
    : null;

export function parseUsageHistoryHours(value) {
  const hours = Number(value);
  return USAGE_HISTORY_HOURS.includes(hours) ? hours : 168;
}

export function sanitizeUsageHistoryEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const at = typeof value.at === 'number' ? value.at : Number.NaN;
  if (!Number.isFinite(at) || at <= 0) return null;
  const f5 = percent(value.f5);
  const d7 = percent(value.d7);
  const r5 = timestamp(value.r5);
  const r7 = timestamp(value.r7);
  const sc = Array.isArray(value.sc)
    ? value.sc
        .map((meter) => {
          const n = modelName(meter?.n);
          const p = percent(meter?.p);
          return n && p != null ? { n, p } : null;
        })
        .filter(Boolean)
        .slice(0, 32)
    : [];
  if (f5 == null && d7 == null && sc.length === 0) return null;
  return {
    at: Math.trunc(at),
    ...(f5 == null ? {} : { f5 }),
    ...(d7 == null ? {} : { d7 }),
    ...(r5 ? { r5 } : {}),
    ...(r7 ? { r7 } : {}),
    ...(sc.length ? { sc } : {}),
  };
}

export function usageSnapshotToHistoryEntry(usage, now = Date.now()) {
  if (!usage || usage.error || usage.stale) return null;
  return sanitizeUsageHistoryEntry({
    at: now,
    f5: usage.fiveHour?.pct,
    d7: usage.sevenDay?.pct,
    r5: usage.fiveHour?.resetsAt,
    r7: usage.sevenDay?.resetsAt,
    sc: (Array.isArray(usage.scoped) ? usage.scoped : []).map((meter) => ({
      n: meter.name,
      p: meter.pct,
    })),
  });
}

export function compactUsageHistory(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return [];
  const cutoff = now - USAGE_HISTORY_RETENTION_MS;
  const clean = entries
    .map(sanitizeUsageHistoryEntry)
    .filter((entry) => entry && entry.at >= cutoff && entry.at <= now + 60_000)
    .sort((a, b) => a.at - b.at);
  const deduplicated = [];
  for (const entry of clean) {
    if (deduplicated.at(-1)?.at === entry.at) deduplicated[deduplicated.length - 1] = entry;
    else deduplicated.push(entry);
  }
  return deduplicated.slice(-USAGE_HISTORY_MAX_ENTRIES);
}

async function readHistoryFile(file, now = Date.now()) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return compactUsageHistory(Array.isArray(parsed) ? parsed : parsed.entries || [], now);
  } catch {
    // One-time compatibility with the old unbounded JSONL experiment.
    return compactUsageHistory(
      raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }),
      now,
    );
  }
}

async function writeHistoryFile(file, entries) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

const serialized = (file, task) => {
  const previous = fileQueues.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  const tracked = next
    .catch(() => {})
    .finally(() => {
      if (fileQueues.get(file) === tracked) fileQueues.delete(file);
    });
  fileQueues.set(file, tracked);
  return next;
};

export async function appendUsageHistory(file, usage, now = Date.now()) {
  const entry = usageSnapshotToHistoryEntry(usage, now);
  if (!entry) return false;
  return serialized(file, async () => {
    const entries = await readHistoryFile(file, now);
    if (entries.length && entry.at - entries.at(-1).at < USAGE_HISTORY_MIN_SAMPLE_MS) return false;
    const compacted = compactUsageHistory([...entries, entry], now);
    await writeHistoryFile(file, compacted);
    return true;
  });
}

export async function queryUsageHistory(file, hours, now = Date.now()) {
  const selectedHours = parseUsageHistoryHours(hours);
  const cutoff = now - selectedHours * 60 * 60 * 1000;
  const entries = (await readHistoryFile(file, now)).filter((entry) => entry.at >= cutoff);
  return { now, hours: selectedHours, entries };
}

export async function compactUsageHistoryFile(file, now = Date.now()) {
  return serialized(file, async () => {
    const entries = await readHistoryFile(file, now);
    await writeHistoryFile(file, entries);
    return entries.length;
  });
}
