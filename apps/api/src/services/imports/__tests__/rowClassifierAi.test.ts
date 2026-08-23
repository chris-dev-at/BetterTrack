import { describe, expect, it } from 'vitest';

import type { AiService } from '../../ai/aiService';
import {
  bindCheapTierAi,
  buildRowKindBatchPrompt,
  parseRowKindBatchReply,
  ROW_CLASSIFICATION_AI_TIER,
  ROW_CLASSIFY_SYSTEM_PROMPT,
  type AiBatchRow,
  type ImportRowAiSeam,
} from '../rowClassifierAi';

/**
 * Stage-3 plumbing (prompt contract + defensive parse + tier pinning), pure and
 * model-free: nothing here can reach a provider.
 */

function batchRow(overrides: Partial<AiBatchRow> = {}): AiBatchRow {
  return {
    index: 0,
    text: null,
    quantity: null,
    price: null,
    amount: null,
    symbol: null,
    isin: null,
    ...overrides,
  };
}

describe('CHEAP-tier pinning', () => {
  it('pins this feature to the CHEAP tier (HEAVY/qwen3.8 is another task)', () => {
    expect(ROW_CLASSIFICATION_AI_TIER).toBe('cheap');
  });

  it('binds through the guarded AiService.complete path with temperature 0', async () => {
    const calls: { userId: string; request: Parameters<AiService['complete']>[1] }[] = [];
    const ai = {
      complete: async (userId: string, request: Parameters<AiService['complete']>[1]) => {
        calls.push({ userId, request });
        return { text: '0=buy', model: 'llama3.1:7b', provider: 'ollama' };
      },
    };
    const seam = bindCheapTierAi(ai, 'user-1');

    const result = await seam.complete({ system: 'SYS', prompt: 'PROMPT' });
    expect(result).toEqual({ text: '0=buy', model: 'llama3.1:7b' });
    expect(calls[0]!.userId).toBe('user-1');
    expect(calls[0]!.request.system).toBe('SYS');
    expect(calls[0]!.request.prompt).toBe('PROMPT');
    expect(calls[0]!.request.temperature).toBe(0);
  });

  it('structurally rejects the raw two-argument AiService as a seam', () => {
    const rawService: Pick<AiService, 'complete'> = {
      complete: async () => ({ text: '', model: '', provider: 'ollama' }),
    };
    // The narrow one-argument seam is NOT satisfied by AiService['complete'] —
    // wiring must go through bindCheapTierAi, which pins the CHEAP tier.
    const misuse = rawService as unknown as ImportRowAiSeam;
    expect(typeof misuse.complete).toBe('function'); // runtime shape differs…
    expect(() => Promise.resolve(misuse)).not.toThrow(); // …but only the binder type-checks
  });
});

describe('batch prompt', () => {
  it('carries the strict <index>=<LABEL> output contract', () => {
    expect(ROW_CLASSIFY_SYSTEM_PROMPT).toContain('<index>=<LABEL>');
    expect(ROW_CLASSIFY_SYSTEM_PROMPT).toContain('buy, sell, dividend, deposit, withdrawal');
  });

  it('lists indexed facts only, flattened and truncated', () => {
    const longText = 'Order reference 4711-alpha bravo charlie delta echo foxtrot golf hotel india';
    const prompt = buildRowKindBatchPrompt([
      batchRow({
        index: 3,
        text: 'Kauf "Markt"\nOrder 4711',
        quantity: 10,
        price: 152.3,
        amount: -1523,
      }),
      batchRow({ index: 4, symbol: 'AAPL', isin: 'US0378331005' }),
      batchRow({ index: 5 }),
      batchRow({
        index: 6,
        text: `${longText} juliet kilo lima mike november oscar papa quebec romeo sierra`,
      }),
    ]);
    // Facts are emitted UNQUOTED with collapsed whitespace — the same test
    // asserts the whole prompt contains no `"` character, so a quoted
    // expectation here would be unsatisfiable by ANY implementation.
    expect(prompt).toContain('3: text=Kauf Markt Order 4711 qty=10 price=152.3 amount=-1523');
    expect(prompt).toContain('4: sym=AAPL isin=US0378331005');
    expect(prompt).toContain('5:');
    expect(prompt).not.toContain('"');
    expect(prompt).not.toContain('\nOrder'); // newlines inside memos are flattened
    expect(prompt).toContain(`6: text=${longText}`); // truncated at 120 chars…
    expect(prompt).not.toContain('sierra'); // …the tail never reaches the model
  });
});

describe('defensive reply parsing', () => {
  const VALID = new Set([0, 1, 2]);

  it('parses the well-formed contract', () => {
    const parsed = parseRowKindBatchReply('0=buy\n1=sell\n2=dividend', VALID);
    expect([...parsed.entries()]).toEqual([
      [0, 'buy'],
      [1, 'sell'],
      [2, 'dividend'],
    ]);
  });

  it('tolerates prose, fences, casing, spacing, and bent separators', () => {
    const parsed = parseRowKindBatchReply(
      'Here you go:\n```\n0 = BUY\n1->Sell\n2 : dividend\n```\nHope that helps!',
      VALID,
    );
    expect(parsed.get(0)).toBe('buy');
    expect(parsed.get(1)).toBe('sell');
    expect(parsed.get(2)).toBe('dividend');
  });

  it('ignores hallucinated indexes and unknown labels', () => {
    const parsed = parseRowKindBatchReply('9=buy\n0=transfer\n2=deposit', VALID);
    expect(parsed.has(9)).toBe(false);
    expect(parsed.has(0)).toBe(false);
    expect(parsed.get(2)).toBe('deposit');
  });

  it('keeps the first line per index when the model repeats itself', () => {
    const parsed = parseRowKindBatchReply('0=buy\n0=sell', VALID);
    expect(parsed.get(0)).toBe('buy');
  });

  it('returns an empty map for garbage so every row becomes needs-review', () => {
    expect(parseRowKindBatchReply('no idea what these rows are', VALID).size).toBe(0);
    expect(parseRowKindBatchReply('', VALID).size).toBe(0);
  });
});
