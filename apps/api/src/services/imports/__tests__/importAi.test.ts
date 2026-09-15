import { describe, expect, it } from 'vitest';

import type { AiService } from '../../ai/aiService';
import { AiCapExceededError, AiProviderError, AiUnavailableError } from '../../ai/errors';
import { mapColumns, mapColumnsWithAi } from '../columnMapping';
import { bindImportAi, importAiFailureOf, ImportAiSeamError, type ImportAiSeam } from '../importAi';

/**
 * The ONE import AI seam and its ONE binder (#1857).
 *
 * The binder used to REFUSE to run under a test runner, so nothing below this
 * line could be written at all: how a seam actually resolves — which model, whose
 * cap, what a refusal turns into — was structurally unobservable, and the "heavy
 * tier" it protected did not exist. The stub `AiService` here is the whole
 * provider layer this feature can reach, so these tests can assert the real
 * resolution without any chance of a live completion.
 */

/** A stub AiService that records its calls and answers (or throws) on demand. */
function stubAiService(answer: () => Promise<{ text: string; model: string; provider: string }>): {
  ai: Pick<AiService, 'complete'>;
  calls: { userId: string; request: Parameters<AiService['complete']>[1] }[];
} {
  const calls: { userId: string; request: Parameters<AiService['complete']>[1] }[] = [];
  return {
    calls,
    ai: {
      complete: async (userId, request) => {
        calls.push({ userId, request });
        return answer();
      },
    },
  };
}

describe('bindImportAi', () => {
  it('binds through the guarded AiService.complete path with temperature 0', async () => {
    const { ai, calls } = stubAiService(async () => ({
      text: '3=amount',
      model: 'llama3.1:8b',
      provider: 'ollama',
    }));
    const seam = bindImportAi(ai, 'user-1');

    const result = await seam.complete({ system: 'SYS', prompt: 'PROMPT' });
    expect(result).toEqual({ text: '3=amount', model: 'llama3.1:8b' });
    expect(calls[0]!.userId).toBe('user-1');
    expect(calls[0]!.request.system).toBe('SYS');
    expect(calls[0]!.request.prompt).toBe('PROMPT');
    expect(calls[0]!.request.temperature).toBe(0);
  });

  it('resolves the SAME model for the header seam and the row seam', async () => {
    // The tier split claimed these two reached different configured models. The
    // deployment resolves one endpoint/model pair (§6.18), so they do not — and
    // this is the test the old refusal made impossible to write.
    const { ai } = stubAiService(async () => ({
      text: '0=buy',
      model: 'llama3.1:8b',
      provider: 'ollama',
    }));
    const header = await bindImportAi(ai, 'user-1').complete({ system: 'S', prompt: 'P' });
    const rows = await bindImportAi(ai, 'user-1').complete({ system: 'S', prompt: 'P' });
    expect(header.model).toBe(rows.model);
  });

  it('spends the CALLING user’s budget, never a shared one', async () => {
    const { ai, calls } = stubAiService(async () => ({ text: '', model: 'm', provider: 'ollama' }));
    await bindImportAi(ai, 'user-a').complete({ system: 'S', prompt: 'P' });
    await bindImportAi(ai, 'user-b').complete({ system: 'S', prompt: 'P' });
    expect(calls.map((call) => call.userId)).toEqual(['user-a', 'user-b']);
  });

  it('classifies an exhausted daily cap, an unavailable layer and a failed provider apart', async () => {
    const cases: [Error, string][] = [
      [new AiCapExceededError(3600), 'cap-exhausted'],
      [new AiUnavailableError(), 'unavailable'],
      [new AiProviderError(), 'failed'],
      [new Error('socket hang up'), 'failed'],
    ];
    for (const [thrown, failure] of cases) {
      const { ai } = stubAiService(async () => {
        throw thrown;
      });
      const seam = bindImportAi(ai, 'user-1');
      const err = await seam.complete({ system: 'S', prompt: 'P' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportAiSeamError);
      expect((err as ImportAiSeamError).failure).toBe(failure);
    }
  });
});

describe('importAiFailureOf', () => {
  it('reads a seam error’s own verdict, and defaults everything else to failed', () => {
    expect(importAiFailureOf(new ImportAiSeamError('cap-exhausted'))).toBe('cap-exhausted');
    expect(importAiFailureOf(new ImportAiSeamError('unavailable'))).toBe('unavailable');
    // The conservative reading: an unknown failure is never mistaken for a spent
    // budget, because that verdict STOPS the classifier's remaining calls.
    expect(importAiFailureOf(new Error('who knows'))).toBe('failed');
    expect(importAiFailureOf('not an error')).toBe('failed');
  });
});

describe('the header fallback degrades on every seam failure', () => {
  const HEADERS = ['Datum', 'ISIN', 'Handelsplatz'];
  const ROWS = [['2024-01-02', 'DE0007164600', 'Xetra']];

  it('returns the deterministic result when the seam reports a spent daily cap', async () => {
    const failing: ImportAiSeam = {
      complete: async () => {
        throw new ImportAiSeamError('cap-exhausted');
      },
    };
    await expect(mapColumnsWithAi(HEADERS, ROWS, {}, { ai: failing })).resolves.toEqual(
      mapColumns(HEADERS, ROWS),
    );
  });
});
