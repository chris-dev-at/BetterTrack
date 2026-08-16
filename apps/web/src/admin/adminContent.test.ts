import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/admin-content.css'), 'utf8');

describe('admin content responsive contract', () => {
  test('bounds the desktop canvas and contains dense tables locally', () => {
    expect(css).toContain('width: min(100%, 1280px)');
    expect(css).toMatch(/\.bt-admin-content table\s*\{/);
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*position: sticky/);
  });

  test('keeps interactive phone controls at least 44px tall', () => {
    expect(css).toMatch(
      /\.bt-admin :is\(button, a, select, input:not\(\[type='checkbox'\]\):not\(\[type='radio'\]\)\)\s*\{\s*min-height: 44px;/,
    );
  });

  test('turns the admin modal into a phone sheet without changing its dialog semantics', () => {
    expect(css).toMatch(/\.bt-admin-modal\s*\{[\s\S]*border-radius: 16px/);
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*\.bt-admin-modal\s*\{[\s\S]*border-radius: 24px 24px 0 0/,
    );
  });
});
