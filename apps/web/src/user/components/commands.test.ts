import { describe, expect, test } from 'vitest';

import { EN_MESSAGES } from '../../i18n/registry';
import type { MessageNode } from '../../i18n/registry';
import { isParanoidKilledPath } from '../vault/ui/ParanoidSurfaceGate';
import { CREATE_INTENT, CREATE_INTENT_PARAM } from '../routeParams';
import {
  COMMANDS,
  CREATE_COMMANDS,
  SUGGESTED_COMMANDS,
  commandPath,
  filterCommands,
  sectionLabelKeyFor,
  withPortfolioScope,
} from './commands';

/** The palette's own translator: EN source strings, key on a miss. */
function t(key: string): string {
  let node: string | MessageNode | undefined = EN_MESSAGES;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = node[segment];
  }
  return typeof node === 'string' ? node : key;
}

function labels(query: string): string[] {
  return filterCommands(query, t).map((command) => t(command.labelKey));
}

describe('COMMANDS registry', () => {
  test('every label key resolves to real copy', () => {
    const unresolved = COMMANDS.filter((command) => t(command.labelKey) === command.labelKey);
    expect(unresolved.map((c) => c.labelKey)).toEqual([]);
  });

  test('every alias term is lower-case (the filter never upper-cases the needle)', () => {
    const wrong = COMMANDS.flatMap((c) => c.extra ?? []).filter(
      (term) => term !== term.toLowerCase(),
    );
    expect(wrong).toEqual([]);
  });

  test('CREATE_COMMANDS is the create group itself — the menu shares this list', () => {
    expect(CREATE_COMMANDS).toEqual(COMMANDS.filter((command) => command.group === 'create'));
  });

  test('every advertised create command targets a working flow', () => {
    expect(CREATE_COMMANDS.map((command) => [command.labelKey, command.to])).toEqual([
      ['create.trade', '/portfolio?create=trade'],
      ['create.cashFlow', '/portfolio/cash/movements?create=movement'],
      ['create.transfer', '/portfolio/cash/accounts?create=transfer'],
      ['create.blueprint', '/workbench/blueprints/new'],
      ['create.watchlist', '/assets/watchlists?create=1'],
      ['create.alert', '/workbench/alerts?create=1'],
      ['create.idea', '/workbench/blueprints/new'],
      ['create.portfolio', '/portfolios?create=1'],
    ]);
  });

  test('no create intent under /portfolio* reuses the new-portfolio wizard flag', () => {
    // `PortfolioSwitcher` is mounted in the topbar of EVERY `/portfolio*`
    // surface and consumes `?create=1` for its wizard, so a page under that
    // prefix claiming the same value fires two consumers off one link: the
    // wizard opens on top of the flow the user actually asked for.
    const clashing = CREATE_COMMANDS.filter((command) => {
      const path = commandPath(command.to);
      const underSwitcher = path === '/portfolio' || path.startsWith('/portfolio/');
      const intent = new URLSearchParams(command.to.split('?')[1] ?? '').get(CREATE_INTENT_PARAM);
      return underSwitcher && intent === CREATE_INTENT.portfolio;
    });
    expect(clashing.map((command) => command.labelKey)).toEqual([]);
  });

  test('exactly the portfolio-writing create intents are scoped', () => {
    expect(COMMANDS.filter((command) => command.scoped).map((command) => command.labelKey)).toEqual(
      ['create.trade', 'create.cashFlow', 'create.transfer'],
    );
  });
});

describe('withPortfolioScope', () => {
  test('adds the active portfolio without dropping the intent flag', () => {
    expect(withPortfolioScope('/portfolio?create=trade', 'p-2')).toBe(
      '/portfolio?create=trade&portfolio=p-2',
    );
    expect(withPortfolioScope('/portfolio/cash/movements?create=movement', 'p-2')).toBe(
      '/portfolio/cash/movements?create=movement&portfolio=p-2',
    );
  });

  test('leaves the link alone when no portfolio is pinned', () => {
    expect(withPortfolioScope('/portfolio?create=trade', null)).toBe('/portfolio?create=trade');
  });

  test('escapes an id that would otherwise break the query string', () => {
    expect(withPortfolioScope('/portfolio?create=trade', 'a&b=c')).toBe(
      '/portfolio?create=trade&portfolio=a%26b%3Dc',
    );
  });
});

describe('commandPath', () => {
  test('drops the intent flag so route-matrix checks see a real pathname', () => {
    expect(commandPath('/portfolio/cash/movements?create=movement')).toBe(
      '/portfolio/cash/movements',
    );
    expect(commandPath('/workbench/blueprints/new')).toBe('/workbench/blueprints/new');
  });

  test('every create destination resolves to a path the paranoid matrix can judge', () => {
    // The kill list keys off exact pathnames: pass the whole link and
    // `/portfolio/cash/movements?create=movement` slips through as "not killed".
    const killed = COMMANDS.filter((command) => command.group === 'create')
      .filter((command) => isParanoidKilledPath(commandPath(command.to)))
      .map((command) => command.labelKey);
    expect(killed).toEqual(['create.cashFlow']);
  });
});

describe('SUGGESTED_COMMANDS (the empty-query default state)', () => {
  test('offers six curated entries in rank order', () => {
    expect(SUGGESTED_COMMANDS).toHaveLength(6);
    const ranks = SUGGESTED_COMMANDS.map((c) => c.suggested);
    expect(ranks).toEqual([...ranks].sort((a, b) => a! - b!));
  });

  test('leads with the create-a-transaction action, not a navigation row', () => {
    expect(SUGGESTED_COMMANDS[0]!.labelKey).toBe('create.trade');
  });

  test('mixes creation, destinations and Control Center', () => {
    const groups = new Set(SUGGESTED_COMMANDS.map((c) => c.group));
    expect(groups).toEqual(new Set(['create', 'navigate', 'control']));
  });

  test('every suggested entry is a real registry entry', () => {
    for (const entry of SUGGESTED_COMMANDS) expect(COMMANDS).toContain(entry);
  });
});

describe('filterCommands', () => {
  test('an empty query matches nothing (the palette shows Suggested instead)', () => {
    expect(filterCommands('', t)).toEqual([]);
    expect(filterCommands('   ', t)).toEqual([]);
  });

  test('ranks a label prefix above a mid-word containment', () => {
    const hits = labels('cash');
    expect(hits[0]).toBe('Cash');
    // "Backtests" contains no "cash"; "Cash accounts" is a prefix hit too.
    expect(hits).toContain('Cash accounts');
  });

  test('finds a destination by an untranslated alias term', () => {
    expect(labels('paranoid')).toContain('Privacy modes');
    expect(labels('2fa')).toContain('Security');
    expect(labels('csv')).toContain('Import');
  });

  test('a single character only matches the start of a word', () => {
    const hits = labels('x');
    // No label or alias word starts with "x" — mid-word "x" (Tax, Export) must
    // not flood the palette on the first keystroke.
    expect(hits).toEqual([]);
  });

  test('a single character still finds the destinations that start with it', () => {
    expect(labels('w')).toContain('Workbench');
    expect(labels('w')).toContain('Watchlists');
  });

  test('matching is case-insensitive', () => {
    expect(labels('CASH')).toContain('Cash');
  });

  test('is stable within a score (registry order decides ties)', () => {
    const first = filterCommands('new', t);
    const second = filterCommands('new', t);
    expect(first.map((c) => c.labelKey)).toEqual(second.map((c) => c.labelKey));
  });
});

describe('sectionLabelKeyFor', () => {
  test('names the parent section of a nested destination', () => {
    expect(sectionLabelKeyFor('/portfolio/cash')).toBe('nav.portfolios');
    expect(sectionLabelKeyFor('/workbench/blueprints')).toBe('nav.workbench');
    expect(sectionLabelKeyFor('/control/security')).toBe('nav.controlCenter');
  });

  test('leaves a top-level destination without meta (its label already says it)', () => {
    expect(sectionLabelKeyFor('/')).toBeUndefined();
    expect(sectionLabelKeyFor('/portfolio')).toBeUndefined();
    expect(sectionLabelKeyFor('/control')).toBeUndefined();
  });

  test('keeps the section on an action that targets the section root', () => {
    // "Buy or sell" is an action INSIDE Portfolios, not the Portfolios
    // destination — its own label says neither, so the meta has to. Matching
    // the raw link would lose it twice over: `'?'` is not `'/'`.
    expect(sectionLabelKeyFor('/portfolio?create=trade')).toBe('nav.portfolios');
    expect(sectionLabelKeyFor('/portfolio/cash/movements?create=movement')).toBe('nav.portfolios');
    expect(sectionLabelKeyFor('/portfolios?create=1')).toBe('nav.portfolios');
  });
});
