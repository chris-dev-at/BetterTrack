import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The gate on lane E's conversion.
 *
 * The owner's verdict on these surfaces was "all the designs are really clunky
 * … it should be a smooth integrated design not just text and hyperlink anchor
 * text". The audit counted it: ten files here, zero uses of `ODialog`, `Panel`,
 * `Badge`, `Empty`, `Switch` or `Stat`, and 38 raw `bt-link` / `type="radio"` /
 * `type="checkbox"` / `<details>` occurrences. They are gone. This keeps them
 * gone, because every one of them was cheap to write and invisible in review.
 *
 * Origin's own primitives are the way back in: `LinkButton` for a route that
 * should look like a button, `Choice`/`ChoiceGroup` for one-of-N, `CheckRow`
 * for an acknowledgment, `Disclosure` for a fold. A surface that needs one and
 * does not find it should GROW it in `ui/origin`, not hand-roll it here — which
 * is what produced the wall this test exists to prevent.
 */
const UI_DIR = resolve(process.cwd(), 'src/user/vault/ui');

/**
 * Comments are prose, and this lane's prose quotes the very markup it removed
 * ("Was a `<summary className=\"bt-link\">`…"). A gate that cannot tell a
 * quotation from a control would have forced those explanations out of the
 * code — so strip comments, then look only at what actually renders.
 */
function strippedSource(file: string): string {
  return readFileSync(resolve(UI_DIR, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const SOURCE_FILES = readdirSync(UI_DIR)
  .filter((file) => file.endsWith('.tsx') || file.endsWith('.ts'))
  .filter((file) => !file.endsWith('.test.tsx') && !file.endsWith('.test.ts'))
  .sort();

/** Each pattern names the Origin primitive that replaced it. */
const BANNED = [
  {
    label: 'className="bt-link" (use Origin `LinkButton`, or `Button variant="quiet"`)',
    pattern: /className=(?:"[^"]*\bbt-link\b|\{cx\([^)]*['"][^'"]*\bbt-link\b)/,
  },
  {
    label: 'raw <details> (use Origin `Disclosure`)',
    pattern: /<details[\s>]/,
  },
  {
    label: 'raw <input type="radio"> (use Origin `Choice` inside a `ChoiceGroup`)',
    pattern: /type="radio"/,
  },
  {
    label: 'raw <input type="checkbox"> (use Origin `CheckRow`)',
    pattern: /type="checkbox"/,
  },
] as const;

describe('vault UI stays on the Origin primitives', () => {
  it('scans a non-empty set of source files', () => {
    // Guards the gate itself: a moved directory or a changed extension would
    // otherwise turn every assertion below into a vacuous pass.
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(10);
    expect(SOURCE_FILES).toContain('VaultManager.tsx');
    expect(SOURCE_FILES).toContain('VaultCreationCeremony.tsx');
  });

  it.each(BANNED)('never reintroduces $label', ({ pattern }) => {
    const offenders = SOURCE_FILES.filter((file) => pattern.test(strippedSource(file)));
    expect(offenders, `hand-rolled control in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('still reads the real files, comments and all', () => {
    // The stripper must remove comments WITHOUT eating code — otherwise the
    // assertions above pass on an empty string.
    const manager = strippedSource('VaultManager.tsx');
    expect(manager).toContain('export function VaultManager');
    expect(manager).not.toContain('Deferred actions, each with the copy');
  });

  it('reaches for Origin structure rather than hand-rolled panels', () => {
    const imports = SOURCE_FILES.map((file) => strippedSource(file)).join('\n');
    for (const primitive of ['Badge', 'CheckRow', 'Choice', 'Disclosure', 'LinkButton', 'Panel']) {
      expect(imports, `no vault surface imports ${primitive}`).toContain(primitive);
    }
  });
});
