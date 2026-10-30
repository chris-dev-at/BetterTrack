import { z } from 'zod';

/**
 * Announcement bodies (PROJECTPLAN §6.19.6, `docs/announcements-contract.md`
 * §3.2–§3.5): the ONE parser of the markdown subset, pure TypeScript with no
 * dependency beyond zod, shared by the server (validation on every save, the
 * `bodyDoc` it serves, the plain-text projection of the inbox row) and the
 * admin preview. Clients render the typed tree as text nodes — nothing in a
 * {@link BodyDoc} is ever HTML, and no client needs a markdown library or a
 * sanitizer.
 *
 * Hostile input is a design input, not an afterthought: the parser is linear
 * in the input length (every character is visited a bounded number of times,
 * the frame stack is at most {@link ANNOUNCEMENT_EMPHASIS_MAX_DEPTH} + 1 deep,
 * and every look-ahead scan is cached so it cannot be repeated), it never
 * throws, and anything longer than {@link ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT}
 * is cut before it is looked at.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** `notice` banner · `once` card · `ack_required` blocking acknowledgement (§2). */
export const ANNOUNCEMENT_KINDS = ['notice', 'once', 'ack_required'] as const;
export const announcementKindSchema = z.enum(ANNOUNCEMENT_KINDS);
export type AnnouncementKind = z.infer<typeof announcementKindSchema>;

/** `plain` = written before §6.19; `markdown` = the §3.4 subset. */
export const ANNOUNCEMENT_BODY_FORMATS = ['plain', 'markdown'] as const;
export const announcementBodyFormatSchema = z.enum(ANNOUNCEMENT_BODY_FORMATS);
export type AnnouncementBodyFormat = z.infer<typeof announcementBodyFormatSchema>;

/** The two content locales an announcement can carry (EN always, DE optional). */
export const ANNOUNCEMENT_CONTENT_LOCALES = ['en', 'de'] as const;
export const announcementContentLocaleSchema = z.enum(ANNOUNCEMENT_CONTENT_LOCALES);
export type AnnouncementContentLocale = z.infer<typeof announcementContentLocaleSchema>;

// ── Limits (contract §3.4 rule 5) ───────────────────────────────────────────

export const ANNOUNCEMENT_TITLE_MAX_CHARS = 120;
/** `notice` is a banner. */
export const ANNOUNCEMENT_NOTICE_BODY_MAX_CHARS = 2000;
/** `once` and `ack_required` scroll inside a modal. */
export const ANNOUNCEMENT_LONG_BODY_MAX_CHARS = 10_000;
export const ANNOUNCEMENT_BODY_MAX_BLOCKS = 100;
export const ANNOUNCEMENT_BODY_MAX_LINKS = 25;
/** Strong and emphasis nest at most this deep (§3.4 rule 3). */
export const ANNOUNCEMENT_EMPHASIS_MAX_DEPTH = 3;
/** A link target longer than this is refused before any shape check runs. */
export const ANNOUNCEMENT_LINK_TARGET_MAX_CHARS = 2000;
/**
 * Input beyond this many characters is never parsed — the parse covers the
 * prefix and reports `too_long`. Five times the longest legal body, so the
 * admin preview of an over-long draft still shows what was typed.
 */
export const ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT = 5 * ANNOUNCEMENT_LONG_BODY_MAX_CHARS;

/** Body character limit for a kind. */
export function announcementBodyMaxChars(kind: AnnouncementKind): number {
  return kind === 'notice' ? ANNOUNCEMENT_NOTICE_BODY_MAX_CHARS : ANNOUNCEMENT_LONG_BODY_MAX_CHARS;
}

/** Characters of the plain-text projection an inbox row carries for `once` / `ack_required`. */
export const ANNOUNCEMENT_INBOX_EXCERPT_CHARS = 500;

// ── The tree (contract §3.2) ────────────────────────────────────────────────

export type BodyInline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'strong'; c: BodyInline[] }
  | { t: 'em'; c: BodyInline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: BodyInline[] };

export type BodyBlock =
  | { t: 'p'; c: BodyInline[] }
  | { t: 'h'; level: 2 | 3; c: BodyInline[] }
  | { t: 'ul'; items: BodyInline[][] }
  | { t: 'ol'; start: number; items: BodyInline[][] };

export interface BodyDoc {
  v: 1;
  blocks: BodyBlock[];
}

// The lazy getter returns ONE union built once: zod 3 calls a lazy getter on
// every parse, so building the union inside it would cost a fresh schema per
// node of every tree it validates.
export const bodyInlineSchema: z.ZodType<BodyInline> = z.lazy(() => bodyInlineUnion);
const bodyInlineUnion: z.ZodType<BodyInline> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), v: z.string() }).strict(),
  z.object({ t: z.literal('br') }).strict(),
  z.object({ t: z.literal('strong'), c: z.array(bodyInlineSchema) }).strict(),
  z.object({ t: z.literal('em'), c: z.array(bodyInlineSchema) }).strict(),
  z.object({ t: z.literal('code'), v: z.string() }).strict(),
  z.object({ t: z.literal('link'), href: z.string(), c: z.array(bodyInlineSchema) }).strict(),
]);

export const bodyBlockSchema: z.ZodType<BodyBlock> = z.discriminatedUnion('t', [
  z.object({ t: z.literal('p'), c: z.array(bodyInlineSchema) }).strict(),
  z
    .object({
      t: z.literal('h'),
      level: z.union([z.literal(2), z.literal(3)]),
      c: z.array(bodyInlineSchema),
    })
    .strict(),
  z.object({ t: z.literal('ul'), items: z.array(z.array(bodyInlineSchema)) }).strict(),
  z
    .object({
      t: z.literal('ol'),
      start: z.number().int().nonnegative(),
      items: z.array(z.array(bodyInlineSchema)),
    })
    .strict(),
]);

export const bodyDocSchema: z.ZodType<BodyDoc> = z
  .object({ v: z.literal(1), blocks: z.array(bodyBlockSchema) })
  .strict();

// ── Issues ──────────────────────────────────────────────────────────────────

export const ANNOUNCEMENT_BODY_ISSUE_CODES = [
  'link_target',
  'too_many_blocks',
  'too_many_links',
  'too_long',
] as const;
export type AnnouncementBodyIssueCode = (typeof ANNOUNCEMENT_BODY_ISSUE_CODES)[number];

/** One refusal reason, positioned for the composer (1-based line and column, UTF-16 units). */
export interface AnnouncementBodyIssue {
  code: AnnouncementBodyIssueCode;
  line: number;
  column: number;
  message: string;
}

export const announcementBodyIssueSchema = z
  .object({
    /** `titleEn` · `bodyEn` · `titleDe` · `bodyDe` — set by the server when it reports. */
    field: z.string().optional(),
    code: z.enum(ANNOUNCEMENT_BODY_ISSUE_CODES),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    message: z.string(),
  })
  .strict();

// ── Forbidden characters (contract §3.4 rule 1) ─────────────────────────────

/**
 * True for the characters a title or body may never contain: C0 controls other
 * than TAB and LF, every C1 control, and the bidirectional controls that make
 * Trojan-source spoofing possible (U+061C, U+200E, U+200F, U+202A–U+202E,
 * U+2066–U+2069). CR never reaches this check — line endings are normalised
 * to LF first.
 */
export function isForbiddenAnnouncementChar(code: number): boolean {
  if (code < 0x20) return code !== 0x09 && code !== 0x0a;
  if (code >= 0x80 && code <= 0x9f) return true;
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** CRLF and lone CR become LF (contract §3.4 rule 1). */
export function normalizeAnnouncementLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

export interface ForbiddenCharHit {
  line: number;
  column: number;
  /** `U+XXXX` of the refused character. */
  codePoint: string;
}

/** The first forbidden character of `text` (after line-ending normalisation), or null. */
export function findForbiddenAnnouncementChar(text: string): ForbiddenCharHit | null {
  const normalized = normalizeAnnouncementLineEndings(text);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code === 0x0a) {
      line += 1;
      lineStart = i + 1;
      continue;
    }
    if (isForbiddenAnnouncementChar(code)) {
      return {
        line,
        column: i - lineStart + 1,
        codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
      };
    }
  }
  return null;
}

// ── Link targets (contract §3.4 rule 4) ─────────────────────────────────────

const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const URL_TAIL = /^[A-Za-z0-9\-._~:/?#[\]@!$&'*+,;=%]*$/;
const MAILTO = /^mailto:[A-Za-z0-9.!#$%&'*+/=^_{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const APP_PATH = /^\/(?!\/)[A-Za-z0-9/_.~?=&%#-]*$/;

function isHttpsTarget(target: string): boolean {
  if (!target.startsWith('https://')) return false;
  const rest = target.slice('https://'.length);
  let end = rest.length;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (ch === '/' || ch === '?' || ch === '#') {
      end = i;
      break;
    }
  }
  const authority = rest.slice(0, end);
  // No user-info: `https://bank.example@evil.example` reads as the bank and
  // goes to evil. Refusing `@` in the authority closes that door entirely.
  if (authority.length === 0 || authority.includes('@')) return false;
  const colon = authority.indexOf(':');
  const host = colon === -1 ? authority : authority.slice(0, colon);
  if (colon !== -1) {
    const port = authority.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(port)) return false;
  }
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (!labels.every((label) => HOST_LABEL.test(label))) return false;
  return URL_TAIL.test(rest.slice(end));
}

/**
 * Whether `target` is one of the three allowed link shapes: an `https://` URL
 * with a host and no user-info, a `mailto:` with exactly one address, or an app
 * path starting with exactly one `/`. Everything else — `http:`, `javascript:`,
 * `data:`, a protocol-relative `//host`, a backslash path — is refused.
 */
export function isAllowedAnnouncementLinkTarget(target: string): boolean {
  if (target.length === 0 || target.length > ANNOUNCEMENT_LINK_TARGET_MAX_CHARS) return false;
  if (target.startsWith('https://')) return isHttpsTarget(target);
  if (target.startsWith('mailto:')) return MAILTO.test(target);
  if (target.startsWith('/')) return APP_PATH.test(target);
  return false;
}

// ── The parser ──────────────────────────────────────────────────────────────

export interface ParsedAnnouncementBody {
  doc: BodyDoc;
  issues: AnnouncementBodyIssue[];
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '-', '.']);

/** Letters and digits in any script — what makes an `_` intraword. */
const WORD_CHAR = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;

type FrameKind = 'strong' | 'em' | 'link';

interface Frame {
  kind: FrameKind;
  /** The literal text this frame's opener came from, restored if it never closes. */
  opener: string;
  /** `*` or `_` for emphasis; `[` for a link. */
  marker: string;
  children: BodyInline[];
}

interface InlineContext {
  issues: AnnouncementBodyIssue[];
  links: { count: number };
  /** 1-based line of `text[0]` and the column of `text[0]` on that line. */
  line: number;
  column: number;
}

function pushText(target: BodyInline[], value: string): void {
  if (value.length === 0) return;
  const last = target[target.length - 1];
  if (last && last.t === 'text') {
    last.v += value;
  } else {
    target.push({ t: 'text', v: value });
  }
}

function appendAll(target: BodyInline[], nodes: BodyInline[]): void {
  for (const node of nodes) {
    if (node.t === 'text') pushText(target, node.v);
    else target.push(node);
  }
}

/** Fold a frame that never closed back into literal text in its parent. */
function unwindFrame(frame: Frame, parent: BodyInline[]): void {
  pushText(parent, frame.opener);
  appendAll(parent, frame.children);
}

/**
 * Parse the inline content of one block. `text` may contain LF only for a
 * paragraph (each becomes a `br`). Linear: one pass, a frame stack of at most
 * {@link ANNOUNCEMENT_EMPHASIS_MAX_DEPTH} emphasis frames plus one link frame,
 * and the two look-ahead scans (code-span closer, link-target closer) each
 * cached so no character is rescanned more than once.
 */
function parseInline(text: string, ctx: InlineContext): BodyInline[] {
  const root: BodyInline[] = [];
  const stack: Frame[] = [];
  const out = (): BodyInline[] => (stack.length > 0 ? stack[stack.length - 1]!.children : root);
  const emphasisDepth = (): number => stack.filter((f) => f.kind !== 'link').length;

  // Position bookkeeping for issues: line/column of index i in `text`.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0x0a) lineStarts.push(i + 1);
  const positionOf = (index: number): { line: number; column: number } => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    const lineOffset = lo;
    const column = index - lineStarts[lo]! + 1;
    return {
      line: ctx.line + lineOffset,
      column: lineOffset === 0 ? ctx.column + column - 1 : column,
    };
  };

  // The link-target scan is cached: it stops at the first `)` or at the first
  // whitespace, so the region [start, end) holds neither, and any later scan
  // that starts inside it ends at the same place. Without the cache
  // `[](` repeated n times would rescan the tail n times.
  let parenScanStart = -1;
  let parenScanEnd = -1;
  let parenScanFound = false;
  const findParen = (start: number): number => {
    if (parenScanStart !== -1 && start >= parenScanStart && start <= parenScanEnd) {
      return parenScanFound ? parenScanEnd : -1;
    }
    let j = start;
    let found = false;
    for (; j < text.length; j += 1) {
      const c = text[j];
      if (c === ')') {
        found = true;
        break;
      }
      if (c === '\n' || c === ' ' || c === '\t') break;
    }
    parenScanStart = start;
    parenScanEnd = j;
    parenScanFound = found;
    return found ? j : -1;
  };

  /** Close every frame above `index` back into text, then pop and return `stack[index]`. */
  const popTo = (index: number): Frame => {
    while (stack.length - 1 > index) {
      const frame = stack.pop()!;
      unwindFrame(frame, out());
    }
    return stack.pop()!;
  };

  /** Nearest emphasis frame with `marker`, searching down to (not through) a link frame. */
  const findEmphasis = (marker: string): number => {
    for (let i = stack.length - 1; i >= 0; i -= 1) {
      const frame = stack[i]!;
      if (frame.kind === 'link') return -1;
      if (frame.marker === marker) return i;
    }
    return -1;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '\n') {
      out().push({ t: 'br' });
      i += 1;
      continue;
    }

    if (ch === '\\') {
      const next = text[i + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        pushText(out(), next);
        i += 2;
      } else {
        pushText(out(), '\\');
        i += 1;
      }
      continue;
    }

    if (ch === '`') {
      // No cache needed: a failed scan stops at the line end and the region it
      // covered holds no backtick, so the main loop never starts another scan
      // inside it. Every character is scanned at most once.
      let close = -1;
      for (let j = i + 1; j < text.length; j += 1) {
        const c = text[j];
        if (c === '`') {
          close = j;
          break;
        }
        if (c === '\n') break;
      }
      if (close > i + 1) {
        out().push({ t: 'code', v: text.slice(i + 1, close) });
        i = close + 1;
      } else if (close === i + 1) {
        // An empty span is two literal backticks.
        pushText(out(), '``');
        i = close + 1;
      } else {
        pushText(out(), '`');
        i += 1;
      }
      continue;
    }

    if (ch === '[') {
      // Links never nest, and the innermost bracket wins: a `[` while a link
      // is open turns the earlier opener (and anything opened after it) back
      // into text, so `[a [b](/x) c](/y)` links `b` — what the author sees as
      // the link — and leaves the outer brackets literal.
      const open = stack.findIndex((f) => f.kind === 'link');
      if (open !== -1) unwindFrame(popTo(open), out());
      stack.push({ kind: 'link', opener: '[', marker: '[', children: [] });
      i += 1;
      continue;
    }

    if (ch === ']') {
      const linkIndex = stack.findIndex((f) => f.kind === 'link');
      if (linkIndex === -1) {
        pushText(out(), ']');
        i += 1;
        continue;
      }
      const close = text[i + 1] === '(' ? findParen(i + 2) : -1;
      const frame = popTo(linkIndex);
      if (close === -1 || frame.children.length === 0) {
        // No `(target)` — or nothing to click: the brackets are text.
        unwindFrame(frame, out());
        pushText(out(), ']');
        i += 1;
        continue;
      }
      const href = text.slice(i + 2, close);
      if (!isAllowedAnnouncementLinkTarget(href)) {
        const at = positionOf(i + 2);
        ctx.issues.push({
          code: 'link_target',
          line: at.line,
          column: at.column,
          message:
            'Links must point to an https:// address, a single mailto: address or an in-app path starting with /.',
        });
      }
      ctx.links.count += 1;
      if (ctx.links.count === ANNOUNCEMENT_BODY_MAX_LINKS + 1) {
        const at = positionOf(i + 2);
        ctx.issues.push({
          code: 'too_many_links',
          line: at.line,
          column: at.column,
          message: `A body may contain at most ${ANNOUNCEMENT_BODY_MAX_LINKS} links.`,
        });
      }
      out().push({ t: 'link', href, c: frame.children });
      i = close + 1;
      continue;
    }

    if (ch === '*' || ch === '_') {
      let end = i;
      while (end < text.length && text[end] === ch) end += 1;
      const run = end - i;
      // Delimiters are `*` (em), `**` (strong), `***` (both) and a single `_`
      // (em). Any other run — `__init__`, `****` — is text as typed.
      if ((ch === '_' && run !== 1) || run > 3) {
        pushText(out(), text.slice(i, end));
        i = end;
        continue;
      }
      let remaining = run;
      const before = i > 0 ? text[i - 1]! : ' ';
      const after = end < text.length ? text[end]! : ' ';
      const intraword = ch === '_' && WORD_CHAR.test(before) && WORD_CHAR.test(after);
      const canClose = !intraword && !WHITESPACE.test(before);
      const canOpen = !intraword && !WHITESPACE.test(after);

      // Close first: an inner frame before an outer one (`***x***`).
      while (remaining > 0 && canClose) {
        const index = findEmphasis(ch);
        if (index === -1) break;
        const need = stack[index]!.kind === 'strong' ? 2 : 1;
        if (remaining < need) break;
        const frame = popTo(index);
        out().push({ t: frame.kind as 'strong' | 'em', c: frame.children });
        remaining -= need;
      }
      // Then open what is left, strong before em, within the depth limit.
      let literal = '';
      while (remaining > 0) {
        if (!canOpen || emphasisDepth() >= ANNOUNCEMENT_EMPHASIS_MAX_DEPTH) {
          literal += ch.repeat(remaining);
          remaining = 0;
          break;
        }
        if (remaining >= 2) {
          stack.push({ kind: 'strong', opener: ch + ch, marker: ch, children: [] });
          remaining -= 2;
        } else {
          stack.push({ kind: 'em', opener: ch, marker: ch, children: [] });
          remaining -= 1;
        }
      }
      pushText(out(), literal);
      i = end;
      continue;
    }

    // A run of ordinary characters in one step.
    let end = i + 1;
    while (end < text.length) {
      const c = text[end];
      if (
        c === '\n' ||
        c === '\\' ||
        c === '`' ||
        c === '[' ||
        c === ']' ||
        c === '*' ||
        c === '_'
      ) {
        break;
      }
      end += 1;
    }
    pushText(out(), text.slice(i, end));
    i = end;
  }

  while (stack.length > 0) {
    const frame = stack.pop()!;
    unwindFrame(frame, out());
  }
  return root;
}

const HEADING = /^(#{2,3}) /;
const BULLET = /^[-*] /;
const ORDERED = /^([0-9]{1,3})\. /;

type LineKind =
  | { kind: 'blank' }
  | { kind: 'heading'; level: 2 | 3; content: string; offset: number }
  | { kind: 'bullet'; content: string; offset: number }
  | { kind: 'ordered'; start: number; content: string; offset: number }
  | { kind: 'text'; content: string };

function classifyLine(line: string): LineKind {
  if (line.trim().length === 0) return { kind: 'blank' };
  const heading = HEADING.exec(line);
  if (heading) {
    const marker = heading[1]!;
    return {
      kind: 'heading',
      level: marker.length === 2 ? 2 : 3,
      content: line.slice(marker.length + 1),
      offset: marker.length + 1,
    };
  }
  if (BULLET.test(line)) return { kind: 'bullet', content: line.slice(2), offset: 2 };
  const ordered = ORDERED.exec(line);
  if (ordered) {
    const digits = ordered[1]!;
    return {
      kind: 'ordered',
      start: Number.parseInt(digits, 10),
      content: line.slice(digits.length + 2),
      offset: digits.length + 2,
    };
  }
  return { kind: 'text', content: line };
}

function plainBlocks(lines: string[]): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  let current: BodyInline[] | null = null;
  for (const line of lines) {
    if (line.trim().length === 0) {
      current = null;
      continue;
    }
    if (current === null) {
      current = [];
      blocks.push({ t: 'p', c: current });
    } else {
      current.push({ t: 'br' });
    }
    pushText(current, line);
  }
  return blocks;
}

function markdownBlocks(lines: string[], issues: AnnouncementBodyIssue[]): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  const links = { count: 0 };
  let index = 0;
  while (index < lines.length) {
    const lineNumber = index + 1;
    const kind = classifyLine(lines[index]!);
    if (kind.kind === 'blank') {
      index += 1;
      continue;
    }
    if (kind.kind === 'heading') {
      blocks.push({
        t: 'h',
        level: kind.level,
        c: parseInline(kind.content, {
          issues,
          links,
          line: lineNumber,
          column: kind.offset + 1,
        }),
      });
      index += 1;
      continue;
    }
    if (kind.kind === 'bullet' || kind.kind === 'ordered') {
      const items: BodyInline[][] = [];
      const start = kind.kind === 'ordered' ? kind.start : 0;
      while (index < lines.length) {
        const item = classifyLine(lines[index]!);
        if (item.kind !== kind.kind) break;
        items.push(
          parseInline(item.content, { issues, links, line: index + 1, column: item.offset + 1 }),
        );
        index += 1;
      }
      blocks.push(kind.kind === 'ordered' ? { t: 'ol', start, items } : { t: 'ul', items });
      continue;
    }
    // A paragraph: consecutive text lines, each later one after a hard break.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const next = classifyLine(lines[index]!);
      if (next.kind !== 'text') break;
      paragraph.push(next.content);
      index += 1;
    }
    blocks.push({
      t: 'p',
      c: parseInline(paragraph.join('\n'), { issues, links, line: lineNumber, column: 1 }),
    });
  }
  return blocks;
}

/**
 * Parse a stored body into its {@link BodyDoc} and the save-time issues it
 * raises. Never throws. `issues` empty means the body is acceptable as far as
 * the grammar goes; the caller still applies the length limit of the kind and
 * {@link findForbiddenAnnouncementChar}.
 */
export function parseAnnouncementBody(
  source: string,
  format: AnnouncementBodyFormat,
): ParsedAnnouncementBody {
  const issues: AnnouncementBodyIssue[] = [];
  let input = typeof source === 'string' ? source : '';
  if (input.length > ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT) {
    input = input.slice(0, ANNOUNCEMENT_BODY_PARSE_HARD_LIMIT);
    issues.push({
      code: 'too_long',
      line: 1,
      column: 1,
      message: `A body may contain at most ${ANNOUNCEMENT_LONG_BODY_MAX_CHARS} characters.`,
    });
  }
  const lines = normalizeAnnouncementLineEndings(input).split('\n');
  const blocks = format === 'plain' ? plainBlocks(lines) : markdownBlocks(lines, issues);
  if (blocks.length > ANNOUNCEMENT_BODY_MAX_BLOCKS) {
    issues.push({
      code: 'too_many_blocks',
      line: 1,
      column: 1,
      message: `A body may contain at most ${ANNOUNCEMENT_BODY_MAX_BLOCKS} blocks.`,
    });
  }
  return { doc: { v: 1, blocks }, issues };
}

// ── Plain-text projection (contract §3.4, last paragraph) ───────────────────

function inlineText(nodes: BodyInline[]): string {
  let text = '';
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
      case 'code':
        text += node.v;
        break;
      case 'br':
        text += '\n';
        break;
      default:
        text += inlineText(node.c);
    }
  }
  return text;
}

/**
 * The plain-text projection: blocks joined by one blank line; `br` a line
 * break; list items prefixed `- ` or `n. `; links, strong, emphasis and code
 * contribute their text only. The inbox body and the rendering fallback.
 */
export function projectBodyDocToPlainText(doc: BodyDoc): string {
  return doc.blocks
    .map((block) => {
      switch (block.t) {
        case 'p':
        case 'h':
          return inlineText(block.c);
        case 'ul':
          return block.items.map((item) => `- ${inlineText(item)}`).join('\n');
        case 'ol':
          return block.items.map((item, n) => `${block.start + n}. ${inlineText(item)}`).join('\n');
        default:
          return '';
      }
    })
    .join('\n\n');
}

/**
 * Cut a projection to `max` characters plus an ellipsis (the inbox excerpt of
 * `once` / `ack_required`). Never splits a surrogate pair.
 */
export function excerptAnnouncementText(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut).trimEnd()}…`;
}

// ── contentSha256 (contract §3.5) ───────────────────────────────────────────

/**
 * The exact string `contentSha256` is the SHA-256 (lowercase hex, UTF-8) of:
 * `bt-announcement-v1`, LF, kind, LF, contentLocale, LF, bodyFormat, LF,
 * title, LF, body — the stored source after the locale fallback. Clients never
 * compute it; the server does, with this one definition.
 */
export function announcementContentHashPreimage(input: {
  kind: AnnouncementKind;
  locale: AnnouncementContentLocale;
  format: AnnouncementBodyFormat;
  title: string;
  body: string;
}): string {
  return [
    'bt-announcement-v1',
    input.kind,
    input.locale,
    input.format,
    input.title,
    input.body,
  ].join('\n');
}

export const contentSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
