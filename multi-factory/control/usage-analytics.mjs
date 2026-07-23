// Pure ledger pricing/aggregation used by the dashboard and deterministic tests.
// `cost_usd` remains actual CLI-reported/subscription spend. The separate Codex
// estimate below answers: what would the same measured tokens cost at standard
// OpenAI API rates?

export const CODEX_STANDARD_PRICING = Object.freeze({
  'gpt-5.6-sol': Object.freeze({ input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 }),
  'gpt-5.6-terra': Object.freeze({
    input: 2.5,
    cachedInput: 0.25,
    cacheWrite: 3.125,
    output: 15,
  }),
  'gpt-5.6-luna': Object.freeze({ input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 6 }),
});

export const CODEX_PRICING_META = Object.freeze({
  basis: 'OpenAI standard/base API rates per 1M tokens',
  effectiveDate: '2026-07-24',
  ratesPerMillionTokens: CODEX_STANDARD_PRICING,
  cacheWriteRule: '1.25× uncached input rate when separately recorded',
  outputTokensRule: 'output_tokens includes reasoning; reasoning_output_tokens is diagnostic only',
  legacyOutputPolicy: 'Codex rows without an inclusive-output marker are not priced',
  actualSpend: false,
  longContextMultiplierApplied: false,
});

const ownNumber = (row, keys) => {
  for (const key of keys) {
    if (Object.hasOwn(row, key) && Number.isFinite(Number(row[key])) && Number(row[key]) >= 0)
      return { known: true, value: Number(row[key]) };
  }
  return { known: false, value: 0 };
};
const round = (value, places = 6) => {
  const scale = 10 ** places;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};
const dateKey = (value) => (typeof value === 'string' ? value.slice(0, 10) : '');

export function ledgerProvider(row) {
  if (typeof row?.provider === 'string' && row.provider) return row.provider;
  const model = String(row?.model || '').toLowerCase();
  if (model.startsWith('gpt-')) return 'codex';
  if (model.startsWith('claude-')) return 'claude';
  if (model.includes('gemini')) return 'gemini';
  return null;
}

export function normalizeCodexLedgerRow(row) {
  if (ledgerProvider(row) !== 'codex') return null;
  const model = String(row.model || '');
  const rawInput = ownNumber(row, ['input_tokens']);
  const cachedInput = ownNumber(row, ['cached_input_tokens', 'cache_read_tokens']);
  const cacheWrite = ownNumber(row, ['cache_write_input_tokens', 'cache_creation_tokens']);
  const output = ownNumber(row, ['output_tokens']);
  const inclusive =
    row.input_tokens_semantics === 'inclusive' ||
    row.input_tokens_semantics === 'includes-cache' ||
    row.token_accounting === 'inclusive';
  const uncachedInput = inclusive
    ? Math.max(rawInput.value - cachedInput.value - cacheWrite.value, 0)
    : rawInput.value;
  const usage = {
    input: uncachedInput,
    cachedInput: cachedInput.value,
    cacheWrite: cacheWrite.value,
    output: output.value,
  };
  usage.total = usage.input + usage.cachedInput + usage.cacheWrite + usage.output;

  // Cache-write is optional Codex telemetry. When absent there is no separately
  // recorded category to charge. Input, cached input and output are required to
  // avoid presenting a partial historical row as a complete $0 estimate. New
  // ledger rows also carry an explicit completeness/coverage signal because
  // ledger_record necessarily serializes absent numeric categories as zero.
  const outputSemanticsKnown =
    row.output_tokens_semantics === 'inclusive-reasoning' &&
    Number(row.codex_usage_schema || 0) >= 2;
  const explicitlyIncomplete =
    row.codex_telemetry_complete === false ||
    ['missing-telemetry', 'partial-telemetry'].includes(row.api_equivalent_coverage);
  const telemetryComplete =
    outputSemanticsKnown &&
    !explicitlyIncomplete &&
    rawInput.known &&
    cachedInput.known &&
    output.known;
  const rates = CODEX_STANDARD_PRICING[model];
  let estimateUsd = null;
  let pricingStatus = 'complete';
  if (!outputSemanticsKnown) pricingStatus = 'legacy-output-ambiguous';
  else if (!rates) pricingStatus = 'unknown-model';
  else if (!telemetryComplete) pricingStatus = 'partial-telemetry';
  else
    estimateUsd = round(
      (usage.input * rates.input +
        usage.cachedInput * rates.cachedInput +
        usage.cacheWrite * rates.cacheWrite +
        usage.output * rates.output) /
        1_000_000,
    );

  return {
    row,
    model: model || 'unknown',
    usage,
    estimateUsd,
    pricingStatus,
    telemetryComplete,
    cacheWriteRecorded:
      row.cache_write_telemetry === true ||
      (row.cache_write_telemetry !== false &&
        (cacheWrite.value > 0 || Object.hasOwn(row, 'cache_write_input_tokens'))),
  };
}

export function parseUsageRange(value) {
  if (value === 'all') return null;
  const n = Number(value);
  return [14, 30, 90].includes(n) ? n : 14;
}

const emptyBucket = (key) => ({
  k: key,
  records: 0,
  pricedRecords: 0,
  partialTelemetryRecords: 0,
  unknownModelRecords: 0,
  legacyOutputAmbiguousRecords: 0,
  cacheWriteUnreportedRecords: 0,
  estimatedUsdKnown: 0,
  tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0 },
});
const addInfo = (bucket, info) => {
  bucket.records += 1;
  for (const key of Object.keys(bucket.tokens)) bucket.tokens[key] += info.usage[key];
  if (info.estimateUsd == null) {
    if (info.pricingStatus === 'legacy-output-ambiguous')
      bucket.legacyOutputAmbiguousRecords += 1;
    else if (info.pricingStatus === 'unknown-model') bucket.unknownModelRecords += 1;
    else bucket.partialTelemetryRecords += 1;
  } else {
    bucket.pricedRecords += 1;
    bucket.estimatedUsdKnown += info.estimateUsd;
  }
  if (!info.cacheWriteRecorded) bucket.cacheWriteUnreportedRecords += 1;
};
const finishBucket = (bucket) => {
  const { estimatedUsdKnown, ...rest } = bucket;
  const coverage =
    bucket.records === 0
      ? 'none'
      : bucket.pricedRecords === bucket.records && bucket.cacheWriteUnreportedRecords === 0
        ? 'complete'
        : bucket.pricedRecords === 0
          ? 'unavailable'
          : 'partial';
  return {
    ...rest,
    estimatedUsd: bucket.pricedRecords ? round(estimatedUsdKnown) : null,
    coverage,
  };
};
const finishMap = (map) =>
  [...map.values()]
    .map(finishBucket)
    .sort(
      (a, b) =>
        (b.estimatedUsd ?? -1) - (a.estimatedUsd ?? -1) ||
        b.tokens.total - a.tokens.total ||
        a.k.localeCompare(b.k),
    );
const addToMap = (map, key, info) => {
  if (!map.has(key)) map.set(key, emptyBucket(key));
  addInfo(map.get(key), info);
};

const utcDay = (date) => new Date(`${date}T00:00:00.000Z`);
const dayList = (start, end) => {
  const out = [];
  for (let d = utcDay(start); d <= utcDay(end); d = new Date(d.getTime() + 86_400_000))
    out.push(d.toISOString().slice(0, 10));
  return out;
};

export function aggregateCodexUsage(rows, options = {}) {
  const today = (options.now instanceof Date ? options.now : new Date(options.now || Date.now()))
    .toISOString()
    .slice(0, 10);
  const rangeDays = parseUsageRange(options.range ?? options.rangeDays ?? 14);
  const requestedModel = String(options.model || 'all');
  const all = rows.map(normalizeCodexLedgerRow).filter(Boolean);
  const availableModels = [...new Set(all.map((r) => r.model))].sort();
  let filtered = requestedModel === 'all' ? all : all.filter((r) => r.model === requestedModel);
  const dated = filtered.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey(r.row.ts)));
  let start;
  if (rangeDays == null) {
    start = dated.map((r) => dateKey(r.row.ts)).sort()[0] || today;
  } else {
    start = new Date(utcDay(today).getTime() - (rangeDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    filtered = filtered.filter((r) => {
      const d = dateKey(r.row.ts);
      return d >= start && d <= today;
    });
  }

  const totals = emptyBucket('total');
  const byModel = new Map();
  const byRole = new Map();
  const byIssue = new Map();
  const byDay = new Map(dayList(start, today).map((d) => [d, emptyBucket(d)]));
  let cacheWriteTelemetryRecords = 0;
  for (const info of filtered) {
    addInfo(totals, info);
    addToMap(byModel, info.model, info);
    addToMap(byRole, String(info.row.role || '?'), info);
    addToMap(byIssue, String(info.row.issue || '-'), info);
    const day = dateKey(info.row.ts);
    if (byDay.has(day)) addInfo(byDay.get(day), info);
    if (info.cacheWriteRecorded) cacheWriteTelemetryRecords += 1;
  }
  const finishedTotals = finishBucket(totals);
  const todayBucket = finishBucket(byDay.get(today) || emptyBucket(today));
  return {
    pricing: CODEX_PRICING_META,
    range: rangeDays == null ? 'all' : String(rangeDays),
    rangeStart: start,
    rangeEnd: today,
    model: requestedModel,
    availableModels,
    totals: {
      ...finishedTotals,
      cacheWriteTelemetryRecords,
      unpricedRecords: finishedTotals.records - finishedTotals.pricedRecords,
      todayEstimatedUsd: todayBucket.estimatedUsd,
      todayCoverage: todayBucket.coverage,
    },
    days: [...byDay.values()].map(finishBucket),
    byModel: finishMap(byModel),
    byRole: finishMap(byRole),
    byIssue: finishMap(byIssue).map((r) => ({ ...r, label: r.k === '-' ? 'planning' : r.k })),
  };
}

export function buildUsageAnalytics(rows, options = {}) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const today = now.toISOString().slice(0, 10);
  const days = [];
  for (let i = 13; i >= 0; i--)
    days.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  const byDay = Object.fromEntries(days.map((d) => [d, { multi: 0, single: 0 }]));
  const byModel = {};
  const byRole = {};
  const byIssue = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let total = 0;
  for (const row of rows) {
    const cost = Number(row.cost_usd) || 0;
    total += cost;
    const day = dateKey(row.ts);
    if (byDay[day]) byDay[day][row.factory === 'multi' ? 'multi' : 'single'] += cost;
    const model = String(row.model || '?')
      .replace('claude-', '')
      .replace(/-[0-9-]+$/, '');
    byModel[model] = (byModel[model] || 0) + cost;
    byRole[row.role || '?'] = (byRole[row.role || '?'] || 0) + cost;
    byIssue[row.issue || '-'] = (byIssue[row.issue || '-'] || 0) + cost;
    tokens.input += Number(row.input_tokens) || 0;
    tokens.output += Number(row.output_tokens) || 0;
    tokens.cacheRead += Number(row.cache_read_tokens ?? row.cached_input_tokens) || 0;
    tokens.cacheWrite += Number(row.cache_creation_tokens ?? row.cache_write_input_tokens) || 0;
  }
  const issues = Object.keys(byIssue).filter((key) => key !== '-');
  return {
    days: days.map((date) => ({
      date,
      multi: r2(byDay[date].multi),
      single: r2(byDay[date].single),
    })),
    byModel: Object.entries(byModel)
      .map(([k, v]) => ({ k, v: r2(v) }))
      .sort((a, b) => b.v - a.v),
    byRole: Object.entries(byRole)
      .map(([k, v]) => ({ k, v: r2(v) }))
      .sort((a, b) => b.v - a.v),
    topIssues: Object.entries(byIssue)
      .map(([k, v]) => ({ k: k === '-' ? 'planning' : k, v: r2(v) }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 12),
    tokens,
    totals: {
      cost: r2(total),
      records: rows.length,
      issues: issues.length,
      avgPerIssue: issues.length
        ? r2(issues.reduce((sum, key) => sum + byIssue[key], 0) / issues.length)
        : 0,
      today: r2(
        rows
          .filter((row) => dateKey(row.ts) === today)
          .reduce((sum, row) => sum + (Number(row.cost_usd) || 0), 0),
      ),
    },
    codex: aggregateCodexUsage(rows, {
      now,
      range: options.codexRange,
      model: options.codexModel,
    }),
  };
}
