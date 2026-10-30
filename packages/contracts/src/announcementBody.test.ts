import { describe, expect, it } from 'vitest';

import {
  ANNOUNCEMENT_BODY_MAX_BLOCKS,
  ANNOUNCEMENT_BODY_MAX_LINKS,
  ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT,
  announcementContentHashPreimage,
  bodyDocSchema,
  excerptAnnouncementText,
  findForbiddenAnnouncementChar,
  isAllowedAnnouncementLinkTarget,
  parseAnnouncementBody,
  projectBodyDocToPlainText,
  type BodyBlock,
  type BodyInline,
} from './announcementBody';

const md = (source: string) => parseAnnouncementBody(source, 'markdown');
const blocks = (source: string): BodyBlock[] => md(source).doc.blocks;
const inlines = (source: string): BodyInline[] => {
  const [first] = blocks(source);
  if (!first || (first.t !== 'p' && first.t !== 'h')) throw new Error('not an inline block');
  return first.c;
};
const text = (v: string): BodyInline => ({ t: 'text', v });

describe('announcement body — blocks (contract §3.4 rule 2)', () => {
  it('separates paragraphs at blank lines and turns a single line break into a hard break', () => {
    expect(blocks('one\ntwo\n\n\n three')).toEqual([
      { t: 'p', c: [text('one'), { t: 'br' }, text('two')] },
      { t: 'p', c: [text(' three')] },
    ]);
  });

  it('normalises CRLF and lone CR before anything else', () => {
    expect(blocks('a\r\nb\rc')).toEqual([
      { t: 'p', c: [text('a'), { t: 'br' }, text('b'), { t: 'br' }, text('c')] },
    ]);
  });

  it('knows exactly two heading levels — `#` and `####` stay text', () => {
    expect(blocks('## Two\n### Three\n# One\n#### Four\n##NoSpace')).toEqual([
      { t: 'h', level: 2, c: [text('Two')] },
      { t: 'h', level: 3, c: [text('Three')] },
      {
        t: 'p',
        c: [text('# One'), { t: 'br' }, text('#### Four'), { t: 'br' }, text('##NoSpace')],
      },
    ]);
  });

  it('reads a run of `- ` / `* ` lines as one bulleted list and `n. ` lines as a numbered one', () => {
    expect(blocks('- a\n* b\n\n3. c\n4. d\n1.e')).toEqual([
      { t: 'ul', items: [[text('a')], [text('b')]] },
      { t: 'ol', start: 3, items: [[text('c')], [text('d')]] },
      { t: 'p', c: [text('1.e')] },
    ]);
  });

  it('does not nest: an indented marker, a quote, a fence and a rule are paragraph text', () => {
    expect(blocks('  - indented\n> quote\n```\n| a | b |\n---')).toEqual([
      {
        t: 'p',
        c: [
          text('  - indented'),
          { t: 'br' },
          text('> quote'),
          { t: 'br' },
          text('```'),
          { t: 'br' },
          text('| a | b |'),
          { t: 'br' },
          text('---'),
        ],
      },
    ]);
  });

  it('a numbered list keeps 1–3 digits only', () => {
    expect(blocks('1234. x')).toEqual([{ t: 'p', c: [text('1234. x')] }]);
    expect(blocks('007. x')).toEqual([{ t: 'ol', start: 7, items: [[text('x')]] }]);
  });
});

describe('announcement body — inline (contract §3.4 rule 3)', () => {
  it('parses strong, both emphasis spellings and code', () => {
    expect(inlines('**b** *e* _u_ `c *d*`')).toEqual([
      { t: 'strong', c: [text('b')] },
      text(' '),
      { t: 'em', c: [text('e')] },
      text(' '),
      { t: 'em', c: [text('u')] },
      text(' '),
      { t: 'code', v: 'c *d*' },
    ]);
  });

  it('`***x***` is strong around emphasis', () => {
    expect(inlines('***x***')).toEqual([{ t: 'strong', c: [{ t: 'em', c: [text('x')] }] }]);
  });

  it('negative space: an underscore inside a word is text — `snake_case`, `a_b_c`, `__init__`', () => {
    expect(inlines('snake_case a_b_c __init__ file_name_')).toEqual([
      text('snake_case a_b_c __init__ file_name_'),
    ]);
  });

  it('negative space: an opener without a closer in the same block is literal', () => {
    expect(inlines('**bold *em `code [link')).toEqual([text('**bold *em `code [link')]);
    expect(inlines('[text](https://example.com')).toEqual([text('[text](https://example.com')]);
    // A closer in the NEXT block does not count.
    expect(blocks('**a\n\nb**')).toEqual([
      { t: 'p', c: [text('**a')] },
      { t: 'p', c: [text('b**')] },
    ]);
  });

  it('negative space: a delimiter next to whitespace neither opens nor closes', () => {
    expect(inlines('a * b * c ** d **')).toEqual([text('a * b * c ** d **')]);
  });

  it('a backslash makes the listed characters literal and is itself literal before anything else', () => {
    expect(inlines('\\*not em\\* \\_x\\_ \\`y\\` \\[z\\] \\\\ \\a')).toEqual([
      text('*not em* _x_ `y` [z] \\ \\a'),
    ]);
    expect(blocks('\\- not a list\n\\## not a heading\n1\\. not numbered')).toEqual([
      {
        t: 'p',
        c: [
          text('- not a list'),
          { t: 'br' },
          text('## not a heading'),
          { t: 'br' },
          text('1. not numbered'),
        ],
      },
    ]);
  });

  it('raw HTML is text, never markup', () => {
    const doc = md('<script>alert(1)</script> <img src=x onerror=alert(1)>').doc;
    expect(doc.blocks).toEqual([
      { t: 'p', c: [text('<script>alert(1)</script> <img src=x onerror=alert(1)>')] },
    ]);
  });

  it('code holds no markup, and an empty span is two backticks', () => {
    expect(inlines('`**not strong** [x](/y)` ``')).toEqual([
      { t: 'code', v: '**not strong** [x](/y)' },
      text(' ``'),
    ]);
  });

  it('links carry inline children; links never nest', () => {
    expect(inlines('[**Terms**](/legal/terms) and [a [b](/x) c](/y)')).toEqual([
      { t: 'link', href: '/legal/terms', c: [{ t: 'strong', c: [text('Terms')] }] },
      text(' and [a '),
      { t: 'link', href: '/x', c: [text('b')] },
      text(' c](/y)'),
    ]);
  });

  it('strong and emphasis nest at most three deep; the fourth level is literal', () => {
    expect(inlines('*a **b _c *d* c_ b** a*')).toEqual([
      {
        t: 'em',
        c: [
          text('a '),
          {
            t: 'strong',
            c: [text('b '), { t: 'em', c: [text('c *d* c')] }, text(' b')],
          },
          text(' a'),
        ],
      },
    ]);
  });

  it('a link with no text, or a `]` without `(target)`, is text', () => {
    expect(inlines('[](https://example.com) [x] y')).toEqual([
      text('[](https://example.com) [x] y'),
    ]);
  });
});

describe('announcement body — link targets (contract §3.4 rule 4)', () => {
  it.each([
    'https://example.com',
    'https://example.com/path?q=1&r=2#frag',
    'https://sub.example.co.uk:8443/a/b',
    'mailto:privacy@example.com',
    '/settings/notifications',
    '/',
    '/announcements/0199-abc?x=1#top',
  ])('accepts %s', (target) => {
    expect(isAllowedAnnouncementLinkTarget(target)).toBe(true);
    expect(md(`[x](${target})`).issues).toEqual([]);
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'http://example.com',
    'HTTPS://example.com',
    '//evil.example',
    '/\\evil.example',
    'data:text/html,hi',
    'vbscript:x',
    'https://',
    'https:///path',
    'https://bank.example@evil.example/',
    'https://user:pw@example.com',
    'https://exa_mple.com',
    'https://example.com:99999x',
    'https://example.com/<x>',
    'mailto:a@example.com,b@example.com',
    'mailto:a@example.com?cc=b@example.com',
    'mailto:nobody',
    'ftp://example.com',
    'relative/path',
    '#anchor',
    '',
  ])('refuses %j', (target) => {
    expect(isAllowedAnnouncementLinkTarget(target)).toBe(false);
  });

  it('reports a refused target with its line and column', () => {
    const { issues } = md('first line\n- see [here](javascript:alert(1))');
    expect(issues).toEqual([expect.objectContaining({ code: 'link_target', line: 2, column: 14 })]);
  });

  it('a target that would contain whitespace is not a link at all (text, no issue)', () => {
    const { doc, issues } = md('[x](https://example.com/a b)');
    expect(issues).toEqual([]);
    expect(doc.blocks).toEqual([{ t: 'p', c: [text('[x](https://example.com/a b)')] }]);
  });
});

describe('announcement body — limits (contract §3.4 rule 5)', () => {
  it(`refuses more than ${ANNOUNCEMENT_BODY_MAX_BLOCKS} blocks`, () => {
    const at = Array.from({ length: ANNOUNCEMENT_BODY_MAX_BLOCKS }, (_, n) => `p${n}`).join('\n\n');
    expect(md(at).issues).toEqual([]);
    expect(md(`${at}\n\nextra`).issues.map((i) => i.code)).toEqual(['too_many_blocks']);
  });

  it(`refuses more than ${ANNOUNCEMENT_BODY_MAX_LINKS} links`, () => {
    const at = Array.from({ length: ANNOUNCEMENT_BODY_MAX_LINKS }, () => '[a](/x)').join(' ');
    expect(md(at).issues).toEqual([]);
    expect(md(`${at} [b](/y)`).issues.map((i) => i.code)).toEqual(['too_many_links']);
  });
});

describe('announcement body — forbidden characters (contract §3.4 rule 1)', () => {
  it.each([
    ['NUL', '\u0000', 'U+0000'],
    ['BEL', 'a\u0007', 'U+0007'],
    ['VT', '\u000b', 'U+000B'],
    ['ESC', '\u001b[31m', 'U+001B'],
    ['C1 NEL', '\u0085', 'U+0085'],
    ['C1 CSI', '\u009b', 'U+009B'],
    ['ALM', '؜', 'U+061C'],
    ['LRM', '‎', 'U+200E'],
    ['RLM', '‏', 'U+200F'],
    ['RLO', 'abc‮dcba', 'U+202E'],
    ['LRE', '‪', 'U+202A'],
    ['RLI', '⁧', 'U+2067'],
    ['PDI', '⁩', 'U+2069'],
  ])('refuses %s', (_name, input, codePoint) => {
    expect(findForbiddenAnnouncementChar(input)).toEqual(
      expect.objectContaining({ codePoint, line: 1 }),
    );
  });

  it('allows TAB, LF, CR (normalised) and ordinary non-ASCII text', () => {
    expect(findForbiddenAnnouncementChar('a\tb\r\nc\rd — Grüße 😀 שלום')).toBeNull();
  });

  it('positions the refusal by line and column', () => {
    expect(findForbiddenAnnouncementChar('ok\r\nalso ok\nbad‮')).toEqual({
      line: 3,
      column: 4,
      codePoint: 'U+202E',
    });
  });
});

describe('announcement body — plain (legacy) format', () => {
  it('becomes paragraphs and breaks with no markup at all', () => {
    expect(
      parseAnnouncementBody('**not bold** [x](javascript:y)\nline\n\n- not a list', 'plain'),
    ).toEqual({
      doc: {
        v: 1,
        blocks: [
          { t: 'p', c: [text('**not bold** [x](javascript:y)'), { t: 'br' }, text('line')] },
          { t: 'p', c: [text('- not a list')] },
        ],
      },
      issues: [],
    });
  });
});

describe('plain-text projection and excerpt', () => {
  it('joins blocks with a blank line, prefixes list items and keeps only text', () => {
    const { doc } = md(
      '## Title\nignored? no\n\nSee **[the terms](/t)** and `code`.\nNext line\n\n- one\n- *two*\n\n5. five\n6. six',
    );
    expect(projectBodyDocToPlainText(doc)).toBe(
      'Title\n\nignored? no\n\nSee the terms and code.\nNext line\n\n- one\n- two\n\n5. five\n6. six',
    );
  });

  it('excerpts to the limit plus an ellipsis and never splits a surrogate pair', () => {
    expect(excerptAnnouncementText('short', 10)).toBe('short');
    expect(excerptAnnouncementText('abcdefghij-rest', 10)).toBe('abcdefghij…');
    expect(excerptAnnouncementText('abcdefghi😀x', 10)).toBe('abcdefghi…');
  });
});

describe('contentSha256 preimage (contract §3.5)', () => {
  it('is the six LF-joined fields, in order', () => {
    expect(
      announcementContentHashPreimage({
        kind: 'ack_required',
        locale: 'de',
        format: 'markdown',
        title: 'Titel',
        body: 'Text\nzwei',
      }),
    ).toBe('bt-announcement-v1\nack_required\nde\nmarkdown\nTitel\nText\nzwei');
  });
});

// ── Fuzz: hostile input must parse in bounded time, never throw, and always
// yield a tree the wire schema accepts. Seeded, so a failure reproduces.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_ALPHABET = [
  '*',
  '**',
  '***',
  '_',
  '__',
  '`',
  '[',
  ']',
  '(',
  ')',
  '](',
  '](/',
  '](https://x.y',
  '](javascript:',
  '\\',
  '\n',
  '\n\n',
  '\r',
  '\r\n',
  '- ',
  '* ',
  '1. ',
  '## ',
  '### ',
  '#',
  ' ',
  '\t',
  'a',
  'ß',
  '😀',
  '\u0000',
  '\u0085',
  '‮',
  '⁦',
  '<script>',
  '&amp;',
  '\uD800',
  'snake_case',
];

function hostile(random: () => number, length: number): string {
  const parts: string[] = [];
  let size = 0;
  while (size < length) {
    const piece = HOSTILE_ALPHABET[Math.floor(random() * HOSTILE_ALPHABET.length)]!;
    parts.push(piece);
    size += piece.length;
  }
  return parts.join('').slice(0, length);
}

function assertWellFormed(source: string, format: 'plain' | 'markdown'): void {
  const parsed = parseAnnouncementBody(source, format);
  expect(bodyDocSchema.safeParse(parsed.doc).success).toBe(true);
  expect(Array.isArray(parsed.issues)).toBe(true);
  // Total: the projection of whatever came out is computable too.
  expect(typeof projectBodyDocToPlainText(parsed.doc)).toBe('string');
}

describe('announcement body — fuzz', () => {
  it(
    '500 seeded hostile bodies of up to 4 KB parse without throwing into a valid tree',
    { timeout: 60_000 },
    () => {
      const random = mulberry32(0x5eed);
      for (let n = 0; n < 500; n += 1) {
        const source = hostile(random, 1 + Math.floor(random() * 4096));
        assertWellFormed(source, 'markdown');
        assertWellFormed(source, 'plain');
        // Deterministic: the same input yields the same tree.
        expect(md(source)).toEqual(md(source));
      }
    },
  );

  it.each([
    ['unbalanced asterisks', '*a'.repeat(25_000)],
    ['unbalanced strong', '**a'.repeat(16_000)],
    ['triple runs', '***a'.repeat(12_500)],
    ['long delimiter runs', '*'.repeat(50_000)],
    ['open brackets', '['.repeat(50_000)],
    ['close brackets', ']'.repeat(50_000)],
    ['link openers without a paren', '[a]('.repeat(12_500)],
    ['empty links chained to one far paren', `${'[]('.repeat(16_000)})`],
    ['nested-looking links', `${'[a'.repeat(8_000)}${'](/x)'.repeat(4_000)}`],
    ['backticks without closer', '`a'.repeat(25_000)],
    ['backslashes', '\\'.repeat(50_000)],
    ['underscores in words', 'a_'.repeat(25_000)],
    ['one line per list item', '- *x\n'.repeat(10_000)],
    ['control characters', '\u0000\u0007\u0085‮'.repeat(12_500)],
  ])('%s at the parse limit stays linear (< 1 s, no throw)', (_name, source) => {
    expect(source.length).toBeLessThanOrEqual(ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT);
    // Timed: the parse alone. The generous bound is for a loaded CI box — a
    // quadratic path at this size takes minutes, not a second.
    const started = performance.now();
    md(source);
    expect(performance.now() - started).toBeLessThan(1_000);
    assertWellFormed(source, 'markdown');
  });

  it('a 1 MB body is cut at the hard limit, reported as too_long, and still parses fast', () => {
    const random = mulberry32(42);
    const source = hostile(random, 1_048_576);
    const started = performance.now();
    const parsed = md(source);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(parsed.issues.map((i) => i.code)).toContain('too_long');
    expect(bodyDocSchema.safeParse(parsed.doc).success).toBe(true);
    // Only the prefix was looked at.
    expect(md(source.slice(0, ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT)).doc).toEqual(parsed.doc);
  });

  it('a non-string source (a corrupted row) yields an empty document, not an exception', () => {
    expect(parseAnnouncementBody(undefined as unknown as string, 'markdown')).toEqual({
      doc: { v: 1, blocks: [] },
      issues: [],
    });
  });
});
