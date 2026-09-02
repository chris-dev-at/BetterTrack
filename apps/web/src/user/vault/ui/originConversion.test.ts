import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The gate on lane E's conversion.
 *
 * The owner's verdict on these surfaces was "all the designs are really clunky
 * … it should be a smooth integrated design not just text and hyperlink anchor
 * text". The audit counted it: zero uses of `ODialog`, `Panel`, `Badge`,
 * `Empty`, `Switch` or `Stat`, and 40 raw `bt-link` / `type="radio"` /
 * `type="checkbox"` / `<details>` occurrences. They are gone. This keeps them
 * gone, because every one of them was cheap to write and invisible in review.
 *
 * SCOPE IS EVERY SURFACE THE AUDIT NAMED, not just `vault/ui/`. The first draft
 * of this gate watched that one directory, and `PrivacyVaultSection` — which
 * renders on `/control/privacy` directly BELOW the converted vault manager, in
 * the same scroll — kept its bare anchor and its three naked checkboxes with the
 * gate green. A boundary that stops halfway down a page the owner is looking at
 * is not a boundary.
 *
 * Origin's own primitives are the way back in: `LinkButton` for a route that
 * should look like a button, `Choice`/`ChoiceGroup` for one-of-N, `CheckRow` for
 * an acknowledgment, `Disclosure` for a fold. A surface that needs one and does
 * not find it should GROW it in `ui/origin`, not hand-roll it here — which is
 * what produced the wall this test exists to prevent.
 */
const USER_ROOT = resolve(process.cwd(), 'src/user');

/** Whole trees, then the individual files the audit called out by name. */
const SCANNED_TREES = ['vault'];
const SCANNED_FILES = [
  'control/panels/PrivacyVaultSection.tsx',
  'control/panels/PrivacyPanel.tsx',
  'portfolio/LockedPortfolioStub.tsx',
];

function isSource(file: string): boolean {
  return (
    (file.endsWith('.ts') || file.endsWith('.tsx')) &&
    !file.endsWith('.test.ts') &&
    !file.endsWith('.test.tsx')
  );
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (isSource(entry)) found.push(full);
  }
  return found;
}

const SOURCE_FILES = [
  ...SCANNED_TREES.flatMap((tree) => walk(resolve(USER_ROOT, tree))),
  ...SCANNED_FILES.map((file) => resolve(USER_ROOT, file)),
].sort();

/**
 * Comments are prose, and this lane's prose quotes the very markup it removed
 * ("Was a `<summary className=\"bt-link\">`…"). A gate that cannot tell a
 * quotation from a control would have forced those explanations out of the
 * code — so strip comments, then look only at what actually renders.
 */
function strippedSource(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Each pattern names the Origin primitive that replaced it.
 *
 * The spellings matter as much as the names. A rule that only knows
 * `className="bt-link"` is satisfied by `className={cx('bt-link')}`,
 * `className={"bt-link"}` and a template literal — three ways to paint the same
 * underlined text past a green gate. `bt-link` is a class token with no other
 * legitimate use in a component, so the rule is simply: it does not appear in
 * rendered code, however it is spelled.
 */
const BANNED = [
  {
    label: 'bt-link, in any spelling (use Origin `LinkButton`, or `Button variant="quiet"`)',
    pattern: /\bbt-link\b/,
  },
  {
    label: 'raw <details> (use Origin `Disclosure`)',
    pattern: /<details[\s>]/,
  },
  {
    label: 'raw <input type="radio"> (use Origin `Choice` inside a `ChoiceGroup`)',
    pattern: /type=\{?\s*['"`]\s*radio\s*['"`]\s*\}?/,
  },
  {
    label: 'raw <input type="checkbox"> (use Origin `CheckRow`)',
    pattern: /type=\{?\s*['"`]\s*checkbox\s*['"`]\s*\}?/,
  },
] as const;

const shortName = (file: string) => relative(USER_ROOT, file);

describe('vault + privacy surfaces stay on the Origin primitives', () => {
  it('scans every surface the audit named', () => {
    // Guards the gate itself: a moved directory or a changed extension would
    // otherwise turn every assertion below into a vacuous pass.
    const names = SOURCE_FILES.map(shortName);
    expect(SOURCE_FILES.length).toBeGreaterThanOrEqual(20);
    for (const required of [
      'vault/ui/VaultManager.tsx',
      'vault/ui/VaultCreationCeremony.tsx',
      'vault/ui/VaultStateAction.tsx',
      // Below the vault manager in the same scroll — the miss that made this
      // gate watch more than one directory.
      'control/panels/PrivacyVaultSection.tsx',
      'control/panels/PrivacyPanel.tsx',
      'portfolio/LockedPortfolioStub.tsx',
    ]) {
      expect(names, `${required} is not being scanned`).toContain(required);
    }
    // The tree walk must reach BEYOND `vault/ui/`, or "the whole vault tree" is
    // a comment rather than a fact.
    expect(names.some((name) => name.startsWith('vault/') && !name.startsWith('vault/ui/'))).toBe(
      true,
    );
  });

  it.each(BANNED)('never reintroduces $label', ({ pattern }) => {
    const offenders = SOURCE_FILES.filter((file) => pattern.test(strippedSource(file))).map(
      shortName,
    );
    expect(offenders, `hand-rolled control in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('still reads the real files, comments and all', () => {
    // The stripper must remove comments WITHOUT eating code — otherwise the
    // assertions above pass on an empty string.
    const manager = strippedSource(resolve(USER_ROOT, 'vault/ui/VaultManager.tsx'));
    expect(manager).toContain('export function VaultManager');
    expect(manager).not.toContain('Deferred actions, each with the copy');
  });

  it('lets the code keep explaining what it removed', () => {
    // Both of these quote a banned pattern inside a comment and must stay green,
    // or the gate would quietly delete the reasoning behind the conversion.
    for (const [file, quoted] of [
      ['vault/ui/VaultCreationCeremony.tsx', 'bt-link'],
      ['vault/ui/VaultTransferQr.tsx', '<details>'],
    ] as const) {
      const full = resolve(USER_ROOT, file);
      expect(readFileSync(full, 'utf8')).toContain(quoted);
      expect(strippedSource(full)).not.toContain(quoted);
    }
  });

  it('reaches for Origin structure rather than hand-rolled panels', () => {
    const imports = SOURCE_FILES.map((file) => strippedSource(file)).join('\n');
    for (const primitive of ['Badge', 'CheckRow', 'Choice', 'Disclosure', 'LinkButton', 'Panel']) {
      expect(imports, `no scanned surface imports ${primitive}`).toContain(primitive);
    }
  });
});
