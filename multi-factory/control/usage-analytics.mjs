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

export const OPENAI_FAMILY_PRICING_META = Object.freeze({
  basis:
    'API-equivalent estimates only; native Codex uses the pricing table and ClaudeX uses its ledger estimate',
  effectiveDate: '2026-07-24',
  ratesPerMillionTokens: CODEX_STANDARD_PRICING,
  actualSpend: false,
  subscriptionRoutes: Object.freeze(['codex', 'claudex']),
  unknownEstimatePolicy: 'unpriced rows remain null',
});

const ownNumber = (row, keys) => {
  for (const key of keys) {
    if (
      Object.hasOwn(row, key) &&
      typeof row[key] === 'number' &&
      Number.isFinite(row[key]) &&
      row[key] >= 0
    )
      return { known: true, value: row[key] };
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

export function ledgerProviderFamily(row) {
  if (typeof row?.provider_family === 'string' && row.provider_family)
    return row.provider_family.toLowerCase();
  if (typeof row?.providerFamily === 'string' && row.providerFamily)
    return row.providerFamily.toLowerCase();
  const provider = ledgerProvider(row);
  if (provider === 'codex' || provider === 'claudex') return 'openai';
  if (provider === 'claude') return 'anthropic';
  if (provider === 'gemini') return 'google';
  return null;
}

export function ledgerHarness(row) {
  if (typeof row?.harness === 'string' && row.harness) return row.harness;
  const provider = ledgerProvider(row);
  if (provider === 'claudex' || provider === 'claude') return 'claude-code';
  if (provider === 'codex') return 'codex-cli';
  if (provider === 'gemini') return 'antigravity';
  return null;
}

const knownOpenAiRoute = (row, { provider, harness, model }) => {
  const explicitProvider =
    Object.hasOwn(row, 'provider') && typeof row.provider === 'string' && row.provider === provider
      ? provider
      : null;
  const explicitHarness =
    Object.hasOwn(row, 'harness') && typeof row.harness === 'string' && row.harness.trim()
      ? row.harness
      : null;
  const explicitModel =
    Object.hasOwn(row, 'model') &&
    typeof row.model === 'string' &&
    row.model.trim() &&
    model !== 'unknown'
      ? model
      : null;
  return {
    model: explicitModel,
    provider: explicitProvider,
    // Harness is a deterministic property of an explicitly recorded factory
    // provider. Do not derive it when provider itself was inferred from a
    // legacy model-only row.
    harness: explicitHarness || (explicitProvider ? harness : null),
  };
};

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

export function normalizeOpenAiLedgerRow(row) {
  if (ledgerProviderFamily(row) !== 'openai') return null;
  const provider = ledgerProvider(row);
  if (provider !== 'codex' && provider !== 'claudex') return null;
  const providerFamily = 'openai';
  const harness = ledgerHarness(row) || 'unknown';
  const actual = ownNumber(row, ['cost_usd']);
  if (provider === 'codex') {
    const codex = normalizeCodexLedgerRow(row);
    if (!codex) return null;
    return {
      ...codex,
      provider,
      providerFamily,
      harness,
      route: knownOpenAiRoute(row, {
        provider,
        harness,
        model: codex.model,
      }),
      actualUsd: actual.known ? actual.value : null,
    };
  }

  const model = String(row.model || '').replace(/^codex-api\//, '');
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

  const apiEquivalent = ownNumber(row, ['api_equivalent_usd']);
  const explicitlyIncomplete = [
    'missing-telemetry',
    'partial-telemetry',
    'unknown-model',
    'unpriced',
  ].includes(row.api_equivalent_coverage);
  const estimateUsd =
    apiEquivalent.known && !explicitlyIncomplete ? round(apiEquivalent.value) : null;
  return {
    row,
    provider,
    providerFamily,
    harness,
    model: model || 'unknown',
    route: knownOpenAiRoute(row, {
      provider,
      harness,
      model: model || 'unknown',
    }),
    usage,
    estimateUsd,
    actualUsd: actual.known ? actual.value : null,
    pricingStatus: estimateUsd == null ? 'missing-ledger-estimate' : 'complete',
    telemetryComplete: estimateUsd != null,
    cacheWriteRecorded:
      estimateUsd != null ||
      row.cache_write_telemetry === true ||
      (row.cache_write_telemetry !== false &&
        (cacheWrite.value > 0 ||
          Object.hasOwn(row, 'cache_write_input_tokens') ||
          Object.hasOwn(row, 'cache_creation_tokens'))),
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
  missingLedgerEstimateRecords: 0,
  cacheWriteUnreportedRecords: 0,
  estimatedUsdKnown: 0,
  tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, total: 0 },
});
const addInfo = (bucket, info) => {
  bucket.records += 1;
  for (const key of Object.keys(bucket.tokens)) bucket.tokens[key] += info.usage[key];
  if (info.estimateUsd == null) {
    if (info.pricingStatus === 'legacy-output-ambiguous') bucket.legacyOutputAmbiguousRecords += 1;
    else if (info.pricingStatus === 'unknown-model') bucket.unknownModelRecords += 1;
    else if (info.pricingStatus === 'missing-ledger-estimate')
      bucket.missingLedgerEstimateRecords += 1;
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
const addIssueRoute = (map, key, info) => {
  if (!map.has(key))
    map.set(key, {
      models: new Set(),
      providers: new Set(),
      harnesses: new Set(),
    });
  const route = map.get(key);
  if (info.route?.model) route.models.add(info.route.model);
  if (info.route?.provider) route.providers.add(info.route.provider);
  if (info.route?.harness) route.harnesses.add(info.route.harness);
};
const finishIssueRoute = (route) => {
  const sorted = (values) => [...(values || [])].sort();
  const models = sorted(route?.models);
  const providers = sorted(route?.providers);
  const harnesses = sorted(route?.harnesses);
  return {
    model: models.length === 1 ? models[0] : null,
    models,
    provider: providers.length === 1 ? providers[0] : null,
    providers,
    harness: harnesses.length === 1 ? harnesses[0] : null,
    harnesses,
  };
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

const optionFilter = (options, key) => {
  const value = String(options[key] ?? 'all');
  return value && value.length <= 120 ? value : 'all';
};

export function aggregateOpenAiUsage(rows, options = {}) {
  const today = (options.now instanceof Date ? options.now : new Date(options.now || Date.now()))
    .toISOString()
    .slice(0, 10);
  const rangeDays = parseUsageRange(options.range ?? options.rangeDays ?? 14);
  const requested = {
    provider: optionFilter(options, 'provider'),
    providerFamily: optionFilter(options, 'providerFamily'),
    harness: optionFilter(options, 'harness'),
    model: optionFilter(options, 'model'),
    role: optionFilter(options, 'role'),
    issue: optionFilter(options, 'issue'),
  };
  const all = rows.map(normalizeOpenAiLedgerRow).filter(Boolean);
  const available = (selector) => [...new Set(all.map(selector).filter(Boolean))].sort();
  const availableProviders = available((info) => info.provider);
  const availableProviderFamilies = available((info) => info.providerFamily);
  const availableHarnesses = available((info) => info.harness);
  const availableModels = available((info) => info.model);
  const availableRoles = available((info) => String(info.row.role || '?'));
  const availableIssues = available((info) => String(info.row.issue || '-'));
  let filtered = all.filter(
    (info) =>
      (requested.provider === 'all' || info.provider === requested.provider) &&
      (requested.providerFamily === 'all' || info.providerFamily === requested.providerFamily) &&
      (requested.harness === 'all' || info.harness === requested.harness) &&
      (requested.model === 'all' || info.model === requested.model) &&
      (requested.role === 'all' || String(info.row.role || '?') === requested.role) &&
      (requested.issue === 'all' || String(info.row.issue || '-') === requested.issue),
  );
  const dated = filtered.filter((info) => /^\d{4}-\d{2}-\d{2}$/.test(dateKey(info.row.ts)));
  let start;
  if (rangeDays == null) {
    start = dated.map((info) => dateKey(info.row.ts)).sort()[0] || today;
  } else {
    start = new Date(utcDay(today).getTime() - (rangeDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    filtered = filtered.filter((info) => {
      const date = dateKey(info.row.ts);
      return date >= start && date <= today;
    });
  }

  const totals = emptyBucket('total');
  const byProvider = new Map();
  const byProviderFamily = new Map();
  const byHarness = new Map();
  const byModel = new Map();
  const byRole = new Map();
  const byIssue = new Map();
  const byIssueRoute = new Map();
  const byDay = new Map(dayList(start, today).map((date) => [date, emptyBucket(date)]));
  let actualSpendUsd = 0;
  let actualSpendRecords = 0;
  for (const info of filtered) {
    addInfo(totals, info);
    addToMap(byProvider, info.provider, info);
    addToMap(byProviderFamily, info.providerFamily, info);
    addToMap(byHarness, info.harness, info);
    addToMap(byModel, info.model, info);
    addToMap(byRole, String(info.row.role || '?'), info);
    const issue = String(info.row.issue || '-');
    addToMap(byIssue, issue, info);
    addIssueRoute(byIssueRoute, issue, info);
    const day = dateKey(info.row.ts);
    if (byDay.has(day)) addInfo(byDay.get(day), info);
    if (info.actualUsd != null) {
      actualSpendUsd += info.actualUsd;
      actualSpendRecords += 1;
    }
  }
  const finishedTotals = finishBucket(totals);
  return {
    pricing: OPENAI_FAMILY_PRICING_META,
    range: rangeDays == null ? 'all' : String(rangeDays),
    rangeStart: start,
    rangeEnd: today,
    filters: requested,
    availableProviders,
    availableProviderFamilies,
    availableHarnesses,
    availableModels,
    availableRoles,
    availableIssues,
    totals: {
      ...finishedTotals,
      unpricedRecords: finishedTotals.records - finishedTotals.pricedRecords,
      actualSpendUsd: actualSpendRecords ? round(actualSpendUsd) : null,
      actualSpendRecords,
    },
    days: [...byDay.values()].map(finishBucket),
    byProvider: finishMap(byProvider),
    byProviderFamily: finishMap(byProviderFamily),
    byHarness: finishMap(byHarness),
    byModel: finishMap(byModel),
    byRole: finishMap(byRole),
    byIssue: finishMap(byIssue).map((row) => ({
      ...row,
      label: row.k === '-' ? 'planning' : row.k,
      ...finishIssueRoute(byIssueRoute.get(row.k)),
    })),
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
    openai: aggregateOpenAiUsage(rows, {
      now,
      range: options.openAiRange ?? options.codexRange,
      provider: options.provider,
      providerFamily: options.providerFamily,
      harness: options.harness,
      model: options.model,
      role: options.role,
      issue: options.issue,
    }),
  };
}
