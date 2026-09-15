import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import {
  NOTIFICATION_MESSAGE_MONEY_PARAMS,
  type Notification,
  type NotificationMessageKey,
  type NotificationMessageParams,
} from '@bettertrack/contracts';

import type { TranslateFn } from '../i18n';
import deMessages from '../i18n/messages/de.json';
import enMessages from '../i18n/messages/en.json';
import {
  DISCREET_MASK,
  EM_DASH,
  formatMoney,
  formatPercent,
  formatSignedDelta,
  formatSignedMoney,
  formatUnitPrice,
  setDiscreetMode,
} from '../lib/format';
import { notificationText } from '../lib/notificationText';
import { MoneyText } from './MoneyText';
import { StatCard } from './StatCard';

/**
 * The discreet-mode gate (§6.16 / §13.5 V5-P13 arc (a); #682, #1757).
 *
 * §6.16 makes "the toggle is on ⇒ no absolute amount anywhere" an app-wide
 * invariant and names this sweep as its enforcement. It therefore runs in three
 * layers, because the first one alone provably was not enough:
 *
 *   1. **The seam behaves** — every money helper and `MoneyText` prop
 *      combination masks, while percentages/quantities stay live.
 *   2. **Nothing renders money outside the seam** — a source scan over the
 *      whole SPA for raw money formatting (`toFixed`, `Intl.NumberFormat`,
 *      numeric `toLocaleString`) and for a sign applied around a seam call.
 *      Anything not on the commented allowlist below fails the build.
 *   3. **Server-composed sentences mask too** — the inbox is the one surface
 *      whose money arrives already inside a sentence, so it cannot inherit the
 *      seam by construction. The notification catalog is cross-checked against
 *      the shared money-param table and rendered through `notificationText`.
 *
 * Layer 1 used to be the whole file, with its own doc comment conceding the
 * model: *"the reviewer catches the escape via a hard-coded `€`/`$` in the
 * render tree."* They did not: the notification bell — which renders on EVERY
 * authenticated route — printed alert thresholds and dividend payouts straight
 * from the server payload with the toggle on (#1757). Layers 2 and 3 turn the
 * reviewer's eye into a build failure.
 */

afterEach(() => setDiscreetMode(false));

// ───────────────────────── layer 1: the seam behaves ─────────────────────────

// Every money helper used across the SPA — the ones that produce currency-
// formatted output, and therefore ALL must mask under discreet mode. A finder
// grep hit these three; anything new that flows a raw amount to the UI should
// pass through one of them (or MoneyText, tested below).
const MONEY_HELPERS = [
  { label: 'formatMoney', fn: () => formatMoney(1234.56) },
  { label: 'formatMoney (USD)', fn: () => formatMoney(1234.56, 'USD') },
  { label: 'formatUnitPrice', fn: () => formatUnitPrice(0.000012) },
  { label: 'formatUnitPrice (large)', fn: () => formatUnitPrice(1234.56, 'USD') },
  { label: 'formatSignedDelta (+)', fn: () => formatSignedDelta(50) },
  { label: 'formatSignedDelta (-)', fn: () => formatSignedDelta(-50) },
  { label: 'formatSignedMoney (+)', fn: () => formatSignedMoney(50) },
  { label: 'formatSignedMoney (-)', fn: () => formatSignedMoney(-50, 'USD') },
];

// The MoneyText render matrix — every prop combination that could paint a
// currency symbol.
const MONEY_COMPONENTS = [
  { label: 'MoneyText (base currency)', node: <MoneyText amount={1234.56} /> },
  { label: 'MoneyText (native)', node: <MoneyText amount={100} currency="USD" /> },
  {
    label: 'MoneyText (converted)',
    node: <MoneyText amount={100} currency="USD" convertedAmount={92.5} />,
  },
  { label: 'MoneyText (signed +)', node: <MoneyText amount={50} signed /> },
  { label: 'MoneyText (signed -)', node: <MoneyText amount={-50} signed /> },
  { label: 'MoneyText (unit price)', node: <MoneyText amount={0.000012} unitPrice /> },
  {
    label: 'StatCard (MoneyText value)',
    node: (
      <StatCard
        label="Portfolio"
        value={<MoneyText amount={1234.56} />}
        subValue={<MoneyText amount={-50} signed />}
      />
    ),
  },
];

// Every currency symbol the SPA can emit (§7.1 base currencies EUR/USD/CHF/GBP
// plus the intl-emitted USD abbreviation "US$"). Any of these on-screen while
// discreet is ON is a regression — the point of the mode is that NO absolute
// amount surfaces.
const CURRENCY_SYMBOLS = ['€', '$', 'US$', 'CHF', '£'];

/** Assert the rendered text contains no currency-formatted output. */
function assertNoCurrency(text: string): void {
  for (const symbol of CURRENCY_SYMBOLS) {
    expect(text).not.toContain(symbol);
  }
}

describe('discreet-mode sweep (§13.5 V5-P13 arc (a))', () => {
  test('every money helper masks — no currency symbol emitted', () => {
    setDiscreetMode(true);
    for (const { label, fn } of MONEY_HELPERS) {
      const out = fn();
      expect(out, `${label} should mask`).toBe(DISCREET_MASK);
      assertNoCurrency(out);
    }
  });

  test('every money component renders without a currency symbol', () => {
    setDiscreetMode(true);
    for (const { label, node } of MONEY_COMPONENTS) {
      const { container, unmount } = render(node);
      const text = container.textContent ?? '';
      expect(text, `${label} rendered text: ${text}`).toContain(DISCREET_MASK);
      assertNoCurrency(text);
      unmount();
    }
  });

  test('percentages and relative helpers stay live (the "percentages still render" invariant)', () => {
    setDiscreetMode(true);
    // These are the surfaces the acceptance criteria explicitly say must
    // continue to work. They must produce their percent glyph, NOT the mask.
    expect(formatPercent(2.5)).toBe('2,50 %');
    expect(formatPercent(2.5)).not.toBe(DISCREET_MASK);
    expect(formatPercent(0)).toBe('0,00 %');
  });

  test('em dash for missing values wins over the mask (nothing to hide)', () => {
    setDiscreetMode(true);
    expect(formatMoney(null)).toBe(EM_DASH);
    expect(formatUnitPrice(null)).toBe(EM_DASH);
    expect(formatSignedDelta(null)).toBe(EM_DASH);
    expect(formatSignedMoney(null)).toBe(EM_DASH);
  });

  test('a masked amount never leaks its direction', () => {
    // The mask must not tell a bystander whether the number behind it was a
    // gain or a loss — the reason the sign lives inside the seam
    // (MoneyText.tsx, formatSignedMoney) instead of around the call site.
    setDiscreetMode(true);
    expect(formatSignedMoney(50)).toBe(DISCREET_MASK);
    expect(formatSignedMoney(-50)).toBe(DISCREET_MASK);
    const { container } = render(<MoneyText amount={-50} signed />);
    expect(container.textContent).toBe(DISCREET_MASK);
  });

  test('toggling back restores every helper and component exactly', () => {
    // With discreet off (the afterEach reset would apply too, but be explicit):
    setDiscreetMode(false);
    expect(formatMoney(1234.56)).toBe('1.234,56 €');
    expect(formatUnitPrice(0.000012)).toBe('0,000012 €');
    expect(formatSignedDelta(50)).toBe('+50,00');
    expect(formatSignedMoney(-50)).toBe('−50,00 €');

    // Component-level: the exact restored MoneyText output.
    const { container } = render(<MoneyText amount={1234.56} />);
    expect(container.textContent).toContain('1.234,56 €');
  });
});

// ─────────────────── layer 2: the source gate (no money outside the seam) ────

const SRC_ROOT = resolve(process.cwd(), 'src');

/**
 * The seam itself: the two modules that are ALLOWED to turn a number into a
 * money string, because they are the modules that implement the mask.
 */
const SEAM_MODULES = ['lib/format.ts', 'ui/MoneyText.tsx'];

interface MoneyRule {
  readonly id: string;
  /** What the rule looks for. */
  readonly match: RegExp;
  /** A line matching this is a legitimate non-money use and is not counted. */
  readonly except?: RegExp;
  /** The line must ALSO match this to count. */
  readonly also?: RegExp;
  readonly why: string;
}

/**
 * What "renders money outside the seam" looks like in this codebase. Each rule
 * is a line-level regex — deliberately blunt, because a gate that only fires on
 * provably-money call sites is a gate that argues itself out of firing.
 */
const MONEY_RULES: readonly MoneyRule[] = [
  {
    id: 'to-fixed',
    match: /\.toFixed\s*\(/g,
    why: 'formats a number for display without passing the discreet-mode seam',
  },
  {
    id: 'intl-number-format',
    match: /new Intl\.NumberFormat\b/g,
    why: 'builds its own formatter instead of using lib/format',
  },
  {
    id: 'to-locale-string',
    match: /\.toLocaleString\s*\(/g,
    // `new Date(x).toLocaleString()` is the date path; dates are never masked.
    except: /Date|dateStyle|timeStyle/,
    why: 'formats a NUMBER outside the seam',
  },
  {
    id: 'sign-outside-seam',
    match: /\bformat(?:Money|UnitPrice|CompactMoney|SignedMoney)\s*\(/g,
    also: /(['"`])[+\-−]\1/,
    why: 'decorates a seam call with a sign literal, so the mask leaks the direction (§6.16; see MoneyText.tsx and formatSignedMoney)',
  },
];

interface MoneyExemption {
  readonly file: string;
  readonly rule: string;
  /** Exact number of call sites allowed — one more and this gate goes red. */
  readonly count: number;
  readonly reason: string;
}

/**
 * The allowlist. Every entry is a deliberate decision, not a TODO, and the
 * count is pinned: adding a call site to an allowlisted file fails this gate
 * just as loudly as adding one to a fresh file.
 *
 * The three documented §6.16 exemptions come first — they are the cases where
 * masking would DESTROY the output rather than protect it.
 */
const MONEY_EXEMPTIONS: readonly MoneyExemption[] = [
  {
    file: 'user/vault/export/taxCsv.ts',
    rule: 'to-fixed',
    count: 2,
    reason:
      'Documented §6.16 exemption — the client-side tax export. The user asked for this file and reads it outside the app; a masked tax document is a destroyed tax document. (The second call is a quantity, not money.)',
  },
  {
    file: 'user/vault/export/taxPrint.ts',
    rule: 'intl-number-format',
    count: 2,
    reason:
      'Documented §6.16 exemption — the printable half of the same tax export, for the same reason.',
  },
  {
    file: 'user/firstrun/FirstRunFigures.tsx',
    rule: 'intl-number-format',
    count: 1,
    reason:
      'Documented §6.16 exemption — the first-run preference preview exists to SHOW the money format the chosen locale/currency produces. Masked, the figure conveys nothing.',
  },
  {
    file: 'lib/moneyInput.ts',
    rule: 'to-fixed',
    count: 2,
    reason:
      'Documented §6.16 exemption — input parsing, not rendering. These produce the value inside an editable field; masking it would make the field uneditable.',
  },
  {
    file: 'user/workboard/BudgetCalculator.tsx',
    rule: 'to-fixed',
    count: 1,
    reason:
      'Same class as lib/moneyInput: re-quantizes the value of an editable budget input when the user steps it, never paints a figure.',
  },
  {
    file: 'user/assets/AssetDetailPage.tsx',
    rule: 'to-fixed',
    count: 3,
    reason:
      'Earnings EPS (estimate + actual), deliberately NOT masked: EPS is a published company fundamental, the same for every user, and §6.16 enumerates what the mode hides as "balances, values, cash, transaction amounts, tooltips, chart axes" — the user\'s own money. Nothing about the viewer is disclosed. Whoever changes that decision changes this entry with it.',
  },
  {
    file: 'user/components/TransactionDialog.tsx',
    rule: 'to-fixed',
    count: 1,
    reason: 'Renders a derived QUANTITY (share count), not an amount.',
  },
  {
    file: 'user/portfolio/analytics/AnalyticsPage.tsx',
    rule: 'to-fixed',
    count: 1,
    reason: 'An inflation RATE in percent — a relative value, which §6.16 keeps live.',
  },
  {
    file: 'user/home/widgets/PortfolioCardsWidget.tsx',
    rule: 'to-fixed',
    count: 2,
    reason: 'SVG sparkline path coordinates in pixels — no number reaches the user as text.',
  },
  {
    file: 'admin/pages/ProvidersPage.tsx',
    rule: 'to-fixed',
    count: 1,
    reason:
      'A provider hit-rate percentage in the admin console, which renders no user money at all.',
  },
  {
    file: 'admin/pages/UserDetailPage.tsx',
    rule: 'to-locale-string',
    count: 1,
    reason: 'A vault blob size in bytes in the admin console — an operational figure, not money.',
  },
];

/** Every non-test module in the SPA, repo-relative to `apps/web/src`. */
function spaModules(): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (
        /\.tsx?$/.test(entry.name) &&
        !/\.test\.tsx?$/.test(entry.name) &&
        !entry.name.endsWith('.d.ts')
      ) {
        found.push(relative(SRC_ROOT, absolute).split(sep).join('/'));
      }
    }
  };
  walk(SRC_ROOT);
  return found.sort();
}

/**
 * Drop comments before scanning: a rule named in prose ("below toFixed(20)
 * resolution") is documentation, not a call site, and pinning counts against
 * prose would make the gate fight its own comments.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

interface MoneyHit {
  readonly file: string;
  readonly rule: string;
  count: number;
  readonly samples: string[];
}

function scanForMoneyRendering(): Map<string, MoneyHit> {
  const hits = new Map<string, MoneyHit>();
  for (const file of spaModules()) {
    if (SEAM_MODULES.includes(file)) continue;
    const lines = withoutComments(readFileSync(resolve(SRC_ROOT, file), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      for (const rule of MONEY_RULES) {
        const occurrences = [...line.matchAll(rule.match)].length;
        if (occurrences === 0) continue;
        if (rule.except?.test(line)) continue;
        if (rule.also && !rule.also.test(line)) continue;
        const id = `${file} :: ${rule.id}`;
        const hit = hits.get(id) ?? { file, rule: rule.id, count: 0, samples: [] };
        hit.count += occurrences;
        hit.samples.push(`${file}:${index + 1} ${line.trim().slice(0, 100)}`);
        hits.set(id, hit);
      }
    });
  }
  return hits;
}

describe('discreet-mode source gate (§6.16)', () => {
  test('no money is rendered outside the seam except on the commented allowlist', () => {
    const hits = scanForMoneyRendering();
    const allowed = new Map(MONEY_EXEMPTIONS.map((e) => [`${e.file} :: ${e.rule}`, e]));
    const rules = new Map(MONEY_RULES.map((r) => [r.id, r]));

    const violations: string[] = [];
    for (const [id, hit] of hits) {
      const exemption = allowed.get(id);
      if (exemption && exemption.count === hit.count) continue;
      violations.push(
        exemption
          ? `${id}: ${hit.count} call site(s), allowlisted for ${exemption.count}. Review the new one, then update the count.\n    ${hit.samples.join('\n    ')}`
          : `${id}: ${hit.count} call site(s) — ${rules.get(hit.rule)?.why}. Route it through lib/format, or add an allowlist entry in discreetSweep.test.tsx saying why the mask must not apply.\n    ${hit.samples.join('\n    ')}`,
      );
    }
    expect(violations, `discreet-mode gate:\n  ${violations.join('\n  ')}`).toEqual([]);
  });

  test('the allowlist has no stale entries', () => {
    const hits = scanForMoneyRendering();
    const stale = MONEY_EXEMPTIONS.filter((e) => !hits.has(`${e.file} :: ${e.rule}`)).map(
      (e) => `${e.file} :: ${e.rule}`,
    );
    expect(
      stale,
      `allowlisted but no longer present — delete these entries:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  test('the gate itself fires — a sign around a seam call, and a raw toFixed', () => {
    // Guards the gate against silently matching nothing: both regexes are run
    // here against the exact shapes they exist to catch (the pre-#1757
    // TransactionDialog residual hint, and a raw amount render).
    const rule = (id: string): MoneyRule => {
      const found = MONEY_RULES.find((candidate) => candidate.id === id);
      if (!found) throw new Error(`discreet-mode gate lost its "${id}" rule`);
      return found;
    };

    const signRule = rule('sign-outside-seam');
    const leak = `delta: \`\${residual > 0 ? '+' : '−'}\${formatMoney(Math.abs(residual), cur)}\``;
    expect([...leak.matchAll(signRule.match)].length).toBeGreaterThan(0);
    expect(signRule.also?.test(leak)).toBe(true);
    expect([...'value.toFixed(2)'.matchAll(rule('to-fixed').match)].length).toBe(1);
  });
});

// ────────────── layer 3: server-composed sentences (the inbox) ───────────────

type MessageTree = { [key: string]: string | MessageTree };

const EN_TREE = enMessages as unknown as MessageTree;
const DE_TREE = deMessages as unknown as MessageTree;

function lookupMessage(tree: MessageTree, path: string): string | undefined {
  let node: string | MessageTree | undefined = tree;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/** A translator over the real catalogs — the same lookup + interpolation the app does. */
function catalogTranslator(tree: MessageTree): TranslateFn {
  return (key, vars) => {
    const hit = lookupMessage(tree, key) ?? lookupMessage(EN_TREE, key) ?? key;
    if (!vars) return hit;
    return hit.replace(/\{\{(\w+)\}\}/g, (token, name: string) =>
      vars[name] === undefined ? token : String(vars[name]),
    );
  };
}

const SAMPLE_AMOUNT = 1234.56;
const NON_MONEY_SAMPLES: Record<string, string> = {
  currency: 'USD',
  symbol: 'AAPL',
  actor: 'anna',
  date: '2026-03-04',
  category: 'Groceries',
  item: 'Growth',
  chain: 'Family',
  order: 'Monthly buy',
  period: '2026-03',
  count: '3',
  threshold: '5',
};

function templateTokens(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? '');
}

function notificationRow(
  key: NotificationMessageKey,
  params: NotificationMessageParams,
  money?: Record<string, string>,
): Pick<Notification, 'title' | 'body' | 'payload'> {
  return {
    // The persisted fallback deliberately carries a raw amount: if the client
    // ever stopped rendering the descriptor, this text would surface and the
    // assertions below would catch it.
    title: 'Alert triggered',
    body: `AAPL rose above ${SAMPLE_AMOUNT} USD.`,
    payload: { eventKey: `${key}:1`, message: money ? { key, params, money } : { key, params } },
  };
}

/** The catalog paths a money-bearing key renders through. */
function messagePaths(key: NotificationMessageKey): string[] {
  return [`notificationContent.${key}.title`, `notificationContent.${key}.body`];
}

describe('discreet mode masks server-composed notification copy (§6.10 + §6.16)', () => {
  const moneyKeys = Object.keys(NOTIFICATION_MESSAGE_MONEY_PARAMS) as NotificationMessageKey[];

  test('every catalog string carrying a currency is declared money', () => {
    // The completeness direction: a NEW money-bearing notification string that
    // forgets its marker fails here, in both catalogs, before it can reach the
    // bell. `{{currency}}` is the mechanical tell — a template interpolating a
    // denomination is interpolating an amount next to it.
    const undeclared: string[] = [];
    for (const [locale, tree] of [
      ['en', EN_TREE],
      ['de', DE_TREE],
    ] as const) {
      const content = tree.notificationContent as MessageTree;
      for (const key of Object.keys(content)) {
        const pair = content[key] as MessageTree;
        const text = `${String(pair.title ?? '')} ${String(pair.body ?? '')}`;
        if (!text.includes('{{currency}}')) continue;
        if (!(key in NOTIFICATION_MESSAGE_MONEY_PARAMS)) undeclared.push(`${locale}: ${key}`);
      }
    }
    expect(
      undeclared,
      `these notification strings render an amount but are not in NOTIFICATION_MESSAGE_MONEY_PARAMS, so the inbox would print them under discreet mode:\n  ${undeclared.join('\n  ')}`,
    ).toEqual([]);
  });

  test('every declared money param exists in both catalogs', () => {
    for (const key of moneyKeys) {
      const declared = NOTIFICATION_MESSAGE_MONEY_PARAMS[key] ?? {};
      for (const [locale, tree] of [
        ['en', EN_TREE],
        ['de', DE_TREE],
      ] as const) {
        const text = messagePaths(key)
          .map((path) => lookupMessage(tree, path) ?? '')
          .join(' ');
        expect(text, `${locale} catalog is missing notificationContent.${key}`).not.toBe(' ');
        for (const [amountParam, currencyParam] of Object.entries(declared)) {
          expect(text, `${locale} ${key} should interpolate {{${amountParam}}}`).toContain(
            `{{${amountParam}}}`,
          );
          expect(text, `${locale} ${key} should interpolate {{${currencyParam}}}`).toContain(
            `{{${currencyParam}}}`,
          );
        }
      }
    }
  });

  test('the inbox masks every money param and keeps everything else legible', () => {
    for (const key of moneyKeys) {
      const declared = NOTIFICATION_MESSAGE_MONEY_PARAMS[key] ?? {};
      for (const [locale, tree] of [
        ['en', EN_TREE],
        ['de', DE_TREE],
      ] as const) {
        const t = catalogTranslator(tree);
        const body = lookupMessage(tree, `notificationContent.${key}.body`) ?? '';
        const params: NotificationMessageParams = {};
        for (const token of templateTokens(body)) {
          params[token] = token in declared ? SAMPLE_AMOUNT : (NON_MONEY_SAMPLES[token] ?? token);
        }

        setDiscreetMode(false);
        const plain = notificationText(notificationRow(key, params, declared), t);
        expect(
          plain.body,
          `${locale} ${key} should render the amount when discreet is off`,
        ).toContain(String(SAMPLE_AMOUNT));

        setDiscreetMode(true);
        const masked = notificationText(notificationRow(key, params, declared), t);
        expect(masked.body, `${locale} ${key} leaks an amount under discreet mode`).not.toContain(
          String(SAMPLE_AMOUNT),
        );
        expect(masked.body, `${locale} ${key} leaks an amount under discreet mode`).not.toContain(
          '1234',
        );
        expect(masked.body).toContain(DISCREET_MASK);
        // The message must still SAY something: everything that is not an
        // absolute amount survives, including the currency the amount was
        // denominated in.
        for (const token of templateTokens(body)) {
          if (token in declared) continue;
          expect(
            masked.body,
            `${locale} ${key} blanked {{${token}}}, which is not money`,
          ).toContain(String(params[token]));
        }
        setDiscreetMode(false);
      }
    }
  });

  test('a row persisted before the wire marker existed is masked too', () => {
    // Descriptor without `money` — every inbox row written before #1757. The
    // shared key table stands in, so history masks as well as new rows.
    const t = catalogTranslator(EN_TREE);
    const row = notificationRow('alertTriggeredPriceAbove', {
      symbol: 'AAPL',
      threshold: SAMPLE_AMOUNT,
      currency: 'USD',
    });
    setDiscreetMode(true);
    const masked = notificationText(row, t);
    expect(masked.body).toBe('AAPL rose above ••• USD.');
  });

  test('percent alerts are not money — their threshold stays visible', () => {
    const t = catalogTranslator(EN_TREE);
    const row = notificationRow('alertTriggeredPercentDayUp', { symbol: 'AAPL', threshold: 5 });
    setDiscreetMode(true);
    expect(notificationText(row, t).body).toContain('5');
    expect(notificationText(row, t).body).not.toContain(DISCREET_MASK);
  });
});
