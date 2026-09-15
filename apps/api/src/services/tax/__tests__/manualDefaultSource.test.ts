import { describe, expect, it } from 'vitest';

import {
  importSourceTag,
  SOURCE_TAG_MANUAL,
  SOURCE_TAG_STANDING_ORDER,
  SOURCE_TAG_SYNC_MIRRORCHAIN,
  sourceTagSchema,
} from '@bettertrack/contracts';

import { classifySourceTag, manualDefaultAppliesToSource } from '../settings';

/**
 * The manual-per-trade default gate (V5-P4c, V5-P7). One named mapping from a
 * row's V5-P0c source tag to "does this account's configured default apply",
 * so the two planning paths (sells, dividends) can never drift apart and a new
 * tag cannot silently land on the wrong side.
 */
describe('classifySourceTag', () => {
  it('covers the whole source-tag grammar, mirrorchain replicas apart from provider feeds', () => {
    expect(classifySourceTag(SOURCE_TAG_MANUAL)).toBe('manual');
    expect(classifySourceTag(SOURCE_TAG_STANDING_ORDER)).toBe('standing-order');
    expect(classifySourceTag(SOURCE_TAG_SYNC_MIRRORCHAIN)).toBe('mirror-replica');
    expect(classifySourceTag(importSourceTag('george'))).toBe('import');
    expect(classifySourceTag(importSourceTag('trade_republic'))).toBe('import');
    expect(classifySourceTag('sync:parqet')).toBe('provider-sync');
  });

  it('classifies exactly what the contract admits as a tag', () => {
    for (const tag of [
      SOURCE_TAG_MANUAL,
      SOURCE_TAG_STANDING_ORDER,
      SOURCE_TAG_SYNC_MIRRORCHAIN,
      importSourceTag('george'),
      'sync:parqet',
    ]) {
      expect(sourceTagSchema.safeParse(tag).success).toBe(true);
      expect(classifySourceTag(tag)).not.toBe('unrecognized');
    }
    // Anything the grammar rejects is unrecognized rather than half-parsed by
    // a prefix match — `import`/`sync` without a slug included.
    for (const bogus of ['', 'IMPORT:GEORGE', 'import:', 'sync:', 'sync', 'imported:george']) {
      expect(sourceTagSchema.safeParse(bogus).success).toBe(false);
      expect(classifySourceTag(bogus)).toBe('unrecognized');
    }
  });
});

describe('manualDefaultAppliesToSource', () => {
  it('applies the default to rows this account owner is responsible for', () => {
    // Hand-entered here.
    expect(manualDefaultAppliesToSource(SOURCE_TAG_MANUAL)).toBe(true);
    // No tag stamped = a hand-entered write (every non-tagging caller).
    expect(manualDefaultAppliesToSource(undefined)).toBe(true);
    // The owner's own standing instruction, booked on schedule (V5-P6b).
    expect(manualDefaultAppliesToSource(SOURCE_TAG_STANDING_ORDER)).toBe(true);
    // A chain member's write replicated into this copy: §6.17 taxes per copy,
    // under THIS owner's settings — not at zero (issue #1861).
    expect(manualDefaultAppliesToSource(SOURCE_TAG_SYNC_MIRRORCHAIN)).toBe(true);
  });

  it('never applies the default to broker history or third-party feeds', () => {
    // V5-P4c: an import may already carry its own settled tax.
    expect(manualDefaultAppliesToSource(importSourceTag('george'))).toBe(false);
    expect(manualDefaultAppliesToSource(importSourceTag('trade_republic'))).toBe(false);
    // A future `sync:<provider>` feed is an import by another name until a
    // provider argues otherwise in the mapping itself.
    expect(manualDefaultAppliesToSource('sync:parqet')).toBe(false);
    // An unknown origin never invents tax.
    expect(manualDefaultAppliesToSource('whatever')).toBe(false);
  });
});
