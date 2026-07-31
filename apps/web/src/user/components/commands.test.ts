import { describe, expect, test } from 'vitest';

import { EN_MESSAGES } from '../../i18n/registry';
import type { MessageNode } from '../../i18n/registry';
import { COMMANDS, SUGGESTED_COMMANDS, filterCommands, sectionLabelKeyFor } from './commands';

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
});
