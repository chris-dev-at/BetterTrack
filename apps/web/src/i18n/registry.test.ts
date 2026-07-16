import { describe, expect, test } from 'vitest';

import { LOCALES, type MessageNode } from './registry';

/**
 * Key-parity + placeholder-parity gate over the shipped catalogs
 * (§13.4 V4-P11 DE sweep, #528). EN is the source of truth; every non-default
 * locale MUST cover the same key set and preserve every `{{token}}` from the EN
 * source, or a translation is missing / a placeholder was dropped and the app
 * would render an untranslated string or a broken interpolation.
 */

function flatten(
  node: MessageNode,
  prefix = '',
  out = new Map<string, string>(),
): Map<string, string> {
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(path, v);
    else if (v && typeof v === 'object') flatten(v as MessageNode, path, out);
  }
  return out;
}

function placeholders(str: string): string[] {
  return (str.match(/\{\{\w+\}\}/g) ?? []).slice().sort();
}

const enFlat = flatten(LOCALES.en.messages);
const nonDefaultLocales = Object.values(LOCALES).filter((l) => l.code !== 'en');

describe.each(nonDefaultLocales.map((l) => [l.code, l.messages] as const))(
  'catalog parity (en ⇄ %s)',
  (code, messages) => {
    const flat = flatten(messages);

    test(`${code}: covers every key en.json defines (no untranslated fallback)`, () => {
      const missing = [...enFlat.keys()].filter((k) => !flat.has(k));
      expect(missing, `missing in ${code}: ${missing.join(', ')}`).toEqual([]);
    });

    test(`${code}: introduces no orphan keys absent from en.json`, () => {
      const orphan = [...flat.keys()].filter((k) => !enFlat.has(k));
      expect(orphan, `orphan in ${code}: ${orphan.join(', ')}`).toEqual([]);
    });

    test(`${code}: preserves every {{placeholder}} the EN source uses`, () => {
      const drifted: string[] = [];
      for (const [key, en] of enFlat) {
        const translated = flat.get(key);
        if (translated === undefined) continue;
        const enPh = placeholders(en);
        const trPh = placeholders(translated);
        if (JSON.stringify(enPh) !== JSON.stringify(trPh)) {
          drifted.push(`${key} (en: [${enPh.join(', ')}] / ${code}: [${trPh.join(', ')}])`);
        }
      }
      expect(drifted, `placeholder drift in ${code}:\n  ${drifted.join('\n  ')}`).toEqual([]);
    });
  },
);
