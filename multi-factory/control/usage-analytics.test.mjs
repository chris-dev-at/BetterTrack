import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CODEX_STANDARD_PRICING,
  aggregateCodexUsage,
  aggregateOpenAiUsage,
  buildUsageAnalytics,
  ledgerHarness,
  ledgerProvider,
  ledgerProviderFamily,
  normalizeCodexLedgerRow,
  normalizeOpenAiLedgerRow,
  parseUsageRange,
} from './usage-analytics.mjs';

const base = (overrides = {}) => ({
  ts: '2026-07-24T10:00:00Z',
  issue: '10',
  role: 'writer',
  factory: 'multi',
  model: 'gpt-5.6-sol',
  provider: 'codex',
  codex_usage_schema: 2,
  output_tokens_semantics: 'inclusive-reasoning',
  codex_telemetry_complete: true,
  input_tokens: 0,
  cached_input_tokens: 0,
  cache_write_input_tokens: 0,
  output_tokens: 0,
  cost_usd: 0,
  ...overrides,
});

test('official standard/base rates include 1.25x cache-write input', () => {
  assert.deepEqual(CODEX_STANDARD_PRICING['gpt-5.6-sol'], {
    input: 5,
    cachedInput: 0.5,
    cacheWrite: 6.25,
    output: 30,
  });
  assert.equal(CODEX_STANDARD_PRICING['gpt-5.6-terra'].cacheWrite, 3.125);
  assert.equal(CODEX_STANDARD_PRICING['gpt-5.6-luna'].cacheWrite, 1.25);
});

test('marked provider-inferred ledger input is not charged twice or reduced by cache reads', () => {
  const priced = normalizeCodexLedgerRow(
    base({ provider: undefined, input_tokens: 80, cached_input_tokens: 20 }),
  );
  assert.equal(priced.usage.input, 80);
  assert.equal(priced.usage.cachedInput, 20);
  assert.equal(priced.estimateUsd, 0.00041);
});

test('legacy provider-less GPT rows preserve raw tokens but remain unpriced and explicit', () => {
  const row = base({
    provider: undefined,
    input_tokens: 80,
    cached_input_tokens: 20,
    output_tokens: 7,
    reasoning_output_tokens: 2,
  });
  delete row.codex_usage_schema;
  delete row.output_tokens_semantics;
  delete row.codex_telemetry_complete;
  const priced = normalizeCodexLedgerRow(row);
  assert.deepEqual(priced.usage, {
    input: 80,
    cachedInput: 20,
    cacheWrite: 0,
    output: 7,
    total: 107,
  });
  assert.equal(priced.estimateUsd, null);
  assert.equal(priced.pricingStatus, 'legacy-output-ambiguous');
  const aggregate = aggregateCodexUsage([row], {
    now: '2026-07-24T12:00:00Z',
    range: 14,
  });
  assert.equal(aggregate.totals.pricedRecords, 0);
  assert.equal(aggregate.totals.legacyOutputAmbiguousRecords, 1);
  assert.equal(aggregate.totals.estimatedUsd, null);
});

test('inclusive raw input subtracts cached and cache-write categories exactly once', () => {
  const priced = normalizeCodexLedgerRow(
    base({
      input_tokens_semantics: 'inclusive',
      input_tokens: 100,
      cached_input_tokens: 20,
      cache_write_input_tokens: 10,
      output_tokens: 5,
    }),
  );
  assert.deepEqual(priced.usage, {
    input: 70,
    cachedInput: 20,
    cacheWrite: 10,
    output: 5,
    total: 105,
  });
  assert.equal(priced.estimateUsd, 0.000573);
});

test('Terra and Luna use their own standard rates', () => {
  assert.equal(
    normalizeCodexLedgerRow(
      base({ model: 'gpt-5.6-terra', input_tokens: 1_000_000, output_tokens: 1_000_000 }),
    ).estimateUsd,
    17.5,
  );
  assert.equal(
    normalizeCodexLedgerRow(base({ model: 'gpt-5.6-luna', cached_input_tokens: 1_000_000 }))
      .estimateUsd,
    0.1,
  );
});

test('inclusive Codex output is billed once when reasoning is reported as a diagnostic subset', () => {
  const priced = normalizeCodexLedgerRow(base({ output_tokens: 5, reasoning_output_tokens: 2 }));
  assert.equal(priced.usage.output, 5);
  assert.equal(priced.usage.total, 5);
  assert.equal(priced.estimateUsd, 0.00015);
});

test('unknown Codex models retain tokens but never guess an estimate', () => {
  const priced = normalizeCodexLedgerRow(
    base({ provider: 'codex', model: 'gpt-future', input_tokens: 123 }),
  );
  assert.equal(priced.usage.input, 123);
  assert.equal(priced.estimateUsd, null);
  assert.equal(priced.pricingStatus, 'unknown-model');
});

test('partial historical rows are unavailable rather than misleading $0', () => {
  const row = base({ input_tokens: 100 });
  delete row.output_tokens;
  const priced = normalizeCodexLedgerRow(row);
  assert.equal(priced.estimateUsd, null);
  assert.equal(priced.pricingStatus, 'partial-telemetry');
});

test('explicit missing telemetry keeps a zero-filled ledger row unpriced', () => {
  const priced = normalizeCodexLedgerRow(
    base({
      provider: 'codex',
      codex_telemetry_complete: false,
      api_equivalent_coverage: 'missing-telemetry',
    }),
  );
  assert.equal(priced.usage.total, 0);
  assert.equal(priced.telemetryComplete, false);
  assert.equal(priced.estimateUsd, null);
  assert.equal(priced.pricingStatus, 'partial-telemetry');
});

test('an explicit non-Codex provider is never inferred as Codex from a GPT-like model name', () => {
  const row = base({ provider: 'claude', cost_usd: 2.5 });
  assert.equal(ledgerProvider(row), 'claude');
  assert.equal(normalizeCodexLedgerRow(row), null);
  const data = buildUsageAnalytics([row], {
    now: '2026-07-24T12:00:00Z',
    codexRange: 14,
  });
  assert.equal(data.totals.cost, 2.5);
  assert.equal(data.codex.totals.records, 0);
  assert.equal(
    normalizeOpenAiLedgerRow({
      ...row,
      provider: 'openai-api',
      provider_family: 'openai',
    }),
    null,
  );
});

test('historical rows without explicit cache-write telemetry are priced but marked partial', () => {
  const row = base({ input_tokens: 1_000_000 });
  delete row.cache_write_input_tokens;
  row.cache_creation_tokens = 0;
  const data = aggregateCodexUsage([row], {
    now: '2026-07-24T12:00:00Z',
    range: 14,
  });
  assert.equal(data.totals.estimatedUsd, 5);
  assert.equal(data.totals.coverage, 'partial');
  assert.equal(data.totals.cacheWriteUnreportedRecords, 1);
});

test('daily aggregation exposes estimate and tokens with partial coverage', () => {
  const data = aggregateCodexUsage(
    [
      base({ issue: '1', input_tokens: 1_000_000 }),
      base({
        issue: '1',
        role: 'reviewer',
        model: 'gpt-5.6-terra',
        output_tokens: 1_000_000,
      }),
      base({ issue: '2', model: 'gpt-5.6-luna', cached_input_tokens: 1_000_000 }),
      base({ issue: '3', provider: 'codex', model: 'gpt-future', input_tokens: 99 }),
    ],
    { now: '2026-07-24T12:00:00Z', range: 14 },
  );
  assert.equal(data.totals.estimatedUsd, 20.1);
  assert.equal(data.totals.coverage, 'partial');
  assert.equal(data.totals.pricedRecords, 3);
  assert.equal(data.totals.unpricedRecords, 1);
  assert.equal(data.days.at(-1).estimatedUsd, 20.1);
  assert.equal(data.days.at(-1).tokens.total, 3_000_099);
});

test('issue, role and model breakdowns retain token categories and estimates', () => {
  const data = aggregateCodexUsage(
    [
      base({ issue: '42', role: 'writer', input_tokens: 1_000_000 }),
      base({ issue: '42', role: 'reviewer', output_tokens: 1_000_000 }),
    ],
    { now: '2026-07-24T12:00:00Z', range: 14 },
  );
  assert.equal(data.byIssue[0].k, '42');
  assert.equal(data.byIssue[0].estimatedUsd, 35);
  assert.equal(data.byIssue[0].tokens.input, 1_000_000);
  assert.equal(data.byIssue[0].tokens.output, 1_000_000);
  assert.deepEqual(data.byRole.map((r) => r.k).sort(), ['reviewer', 'writer']);
  assert.equal(data.byModel[0].k, 'gpt-5.6-sol');
});

test('time range and model filters are deterministic', () => {
  const rows = [
    base({ ts: '2026-07-01T10:00:00Z', input_tokens: 1_000_000 }),
    base({ ts: '2026-07-24T10:00:00Z', model: 'gpt-5.6-terra', input_tokens: 1_000_000 }),
  ];
  const fourteen = aggregateCodexUsage(rows, {
    now: '2026-07-24T12:00:00Z',
    range: 14,
  });
  assert.equal(fourteen.totals.records, 1);
  assert.equal(fourteen.totals.estimatedUsd, 2.5);
  const thirtySol = aggregateCodexUsage(rows, {
    now: '2026-07-24T12:00:00Z',
    range: 30,
    model: 'gpt-5.6-sol',
  });
  assert.equal(thirtySol.totals.records, 1);
  assert.equal(thirtySol.totals.estimatedUsd, 5);
  assert.equal(parseUsageRange('garbage'), 14);
  assert.equal(parseUsageRange('all'), null);
});

test('API analytics preserves existing spend while adding Codex issue-level response', () => {
  const response = buildUsageAnalytics(
    [
      {
        ts: '2026-07-24T09:00:00Z',
        issue: '7',
        role: 'writer',
        model: 'claude-opus-4-8',
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 2,
        cache_creation_tokens: 1,
        cost_usd: 3.25,
      },
      base({ issue: '8', input_tokens: 1_000_000 }),
    ],
    { now: '2026-07-24T12:00:00Z', codexRange: 14 },
  );
  assert.equal(response.totals.cost, 3.25);
  assert.equal(response.tokens.input, 1_000_010);
  assert.equal(response.codex.byIssue[0].k, '8');
  assert.equal(response.codex.byIssue[0].estimatedUsd, 5);
  assert.doesNotThrow(() => JSON.stringify(response));
});

test('ClaudeX ledger estimates are OpenAI-family subscription estimates, not actual spend', () => {
  const row = {
    ts: '2026-07-24T10:00:00Z',
    issue: '88',
    role: 'writer',
    factory: 'multi',
    provider: 'claudex',
    provider_family: 'openai',
    harness: 'claude-code',
    model: 'codex-api/gpt-5.6-sol',
    input_tokens: 100,
    output_tokens: 20,
    cache_read_tokens: 40,
    cache_creation_tokens: 10,
    cost_usd: 0,
    api_equivalent_usd: 0.123456,
    api_equivalent_coverage: 'complete',
  };
  assert.equal(ledgerProvider(row), 'claudex');
  assert.equal(ledgerProviderFamily(row), 'openai');
  assert.equal(ledgerHarness(row), 'claude-code');
  assert.equal(normalizeCodexLedgerRow(row), null);
  const info = normalizeOpenAiLedgerRow(row);
  assert.equal(info.model, 'gpt-5.6-sol');
  assert.equal(info.estimateUsd, 0.123456);
  assert.equal(info.actualUsd, 0);
  assert.equal(info.usage.total, 170);

  const data = aggregateOpenAiUsage([row], {
    now: '2026-07-24T12:00:00Z',
    range: 14,
  });
  assert.equal(data.totals.actualSpendUsd, 0);
  assert.equal(data.totals.estimatedUsd, 0.123456);
  assert.deepEqual(data.availableProviders, ['claudex']);
  assert.deepEqual(data.availableHarnesses, ['claude-code']);
  assert.equal(data.byIssue[0].k, '88');
});

test('OpenAI family combines native Codex and ClaudeX while legacy codex stays native-only', () => {
  const native = base({ issue: '40', input_tokens: 1_000_000 });
  const claudex = {
    ts: '2026-07-24T11:00:00Z',
    issue: '41',
    role: 'reviewer',
    factory: 'multi',
    provider: 'claudex',
    provider_family: 'openai',
    harness: 'claude-code',
    model: 'gpt-5.6-terra',
    input_tokens: 10,
    output_tokens: 5,
    cost_usd: 0,
    api_equivalent_usd: 0.2,
    api_equivalent_coverage: 'complete',
  };
  const response = buildUsageAnalytics([native, claudex], {
    now: '2026-07-24T12:00:00Z',
    codexRange: 14,
    openAiRange: 14,
  });
  assert.equal(response.codex.totals.records, 1);
  assert.equal(response.codex.totals.estimatedUsd, 5);
  assert.equal(response.openai.totals.records, 2);
  assert.equal(response.openai.totals.estimatedUsd, 5.2);
  assert.deepEqual(response.openai.byProvider.map((entry) => entry.k).sort(), ['claudex', 'codex']);
  assert.deepEqual(response.openai.byHarness.map((entry) => entry.k).sort(), [
    'claude-code',
    'codex-cli',
  ]);
});

test('OpenAI filters cover provider, harness, model, role and issue', () => {
  const rows = [
    base({ issue: '40', role: 'writer', input_tokens: 1_000_000 }),
    {
      ts: '2026-07-24T11:00:00Z',
      issue: '41',
      role: 'reviewer',
      provider: 'claudex',
      provider_family: 'openai',
      harness: 'claude-code',
      model: 'gpt-5.6-terra',
      cost_usd: 0,
      api_equivalent_usd: 0.2,
      api_equivalent_coverage: 'complete',
    },
  ];
  const data = aggregateOpenAiUsage(rows, {
    now: '2026-07-24T12:00:00Z',
    range: 14,
    provider: 'claudex',
    harness: 'claude-code',
    model: 'gpt-5.6-terra',
    role: 'reviewer',
    issue: '41',
  });
  assert.equal(data.totals.records, 1);
  assert.equal(data.byProvider[0].k, 'claudex');
  assert.equal(data.byIssue[0].k, '41');
  assert.equal(data.filters.issue, '41');
});

test('missing or explicitly incomplete ClaudeX estimates stay null instead of fabricated zero', () => {
  const missing = {
    ts: '2026-07-24T11:00:00Z',
    provider: 'claudex',
    provider_family: 'openai',
    harness: 'claude-code',
    model: 'gpt-5.6-luna',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  };
  const partial = {
    ...missing,
    api_equivalent_usd: 0,
    api_equivalent_coverage: 'partial-telemetry',
  };
  assert.equal(normalizeOpenAiLedgerRow(missing).estimateUsd, null);
  assert.equal(normalizeOpenAiLedgerRow(partial).estimateUsd, null);
  const data = aggregateOpenAiUsage([missing, partial], {
    now: '2026-07-24T12:00:00Z',
    range: 14,
  });
  assert.equal(data.totals.estimatedUsd, null);
  assert.equal(data.totals.unpricedRecords, 2);
  assert.equal(data.totals.missingLedgerEstimateRecords, 2);
});

test('null, empty-string and boolean estimate fields are never coerced into false zero prices', () => {
  for (const api_equivalent_usd of [null, '', false, true]) {
    const row = {
      ts: '2026-07-24T11:00:00Z',
      provider: 'claudex',
      provider_family: 'openai',
      harness: 'claude-code',
      model: 'gpt-5.6-luna',
      input_tokens: null,
      output_tokens: '',
      cost_usd: false,
      api_equivalent_usd,
      api_equivalent_coverage: 'complete',
    };
    const info = normalizeOpenAiLedgerRow(row);
    assert.equal(info.estimateUsd, null);
    assert.equal(info.actualUsd, null);
    assert.equal(info.usage.total, 0);
  }
});

test('dashboard JavaScript parses and carries explicit estimate disclosure', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /API-equivalent estimate · not billed subscription spend/);
  assert.match(html, /not an invoice or actual billed spend/);
  assert.match(html, /long-context multiplier is not applied/);
  assert.match(html, /ua-codex-issues/);
});
