import type { Request } from 'express';

const CRLF = Buffer.from('\r\n');
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');
const BUSBOY_MAX_HEADER_BYTES = 16 * 1024;

/** Maximum MIME header fields accepted on any one multipart part. */
export const MULTIPART_HEADER_PAIRS_LIMIT = 32;

export interface MultipartHeaderPairObservation {
  /** Detach the observer and report an unsafe boundary or over-limit part. */
  finish(): boolean;
}

type ScannerState = 'opening-boundary' | 'headers' | 'body' | 'done';

type MultipartBoundary =
  | { kind: 'not-multipart' }
  | { kind: 'invalid' }
  | { kind: 'valid'; value: string };

const HTTP_TOKEN_CHARACTER = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]$/;

function isOws(value: string): boolean {
  return value === ' ' || value === '\t';
}

function multipartBoundary(contentType: string | undefined): MultipartBoundary {
  if (!contentType) return { kind: 'not-multipart' };

  const mediaType = /^multipart\/form-data/i.exec(contentType);
  if (!mediaType) return { kind: 'not-multipart' };

  let cursor = mediaType[0].length;
  if (
    cursor < contentType.length &&
    !isOws(contentType[cursor] ?? '') &&
    contentType[cursor] !== ';'
  ) {
    return { kind: 'not-multipart' };
  }

  let boundary: string | undefined;
  while (cursor < contentType.length) {
    while (cursor < contentType.length && isOws(contentType[cursor] ?? '')) cursor += 1;
    if (cursor === contentType.length) break;
    if (contentType[cursor] !== ';') return { kind: 'invalid' };
    cursor += 1;

    while (cursor < contentType.length && isOws(contentType[cursor] ?? '')) cursor += 1;
    const nameStart = cursor;
    while (cursor < contentType.length && HTTP_TOKEN_CHARACTER.test(contentType[cursor] ?? '')) {
      cursor += 1;
    }
    if (cursor === nameStart || contentType[cursor] !== '=') return { kind: 'invalid' };
    const name = contentType.slice(nameStart, cursor).toLowerCase();
    cursor += 1;
    if (cursor === contentType.length) return { kind: 'invalid' };

    let value = '';
    if (contentType[cursor] === '"') {
      cursor += 1;
      const valueStart = cursor;
      let closed = false;
      while (cursor < contentType.length) {
        const character = contentType[cursor] ?? '';
        if (character === '\\') {
          // Busboy preserves some quoted escapes and collapses others. Reject
          // escaped boundary values so this guard can never scan for bytes that
          // differ from Multer's parser. RFC multipart boundaries do not need
          // quote or backslash characters.
          if (name === 'boundary' && boundary === undefined) return { kind: 'invalid' };
          cursor += 2;
          if (cursor > contentType.length) return { kind: 'invalid' };
          continue;
        }
        if (character === '"') {
          value = contentType.slice(valueStart, cursor);
          cursor += 1;
          closed = true;
          break;
        }
        const code = character.charCodeAt(0);
        // Busboy encodes its boundary needle as UTF-8 while this raw-stream
        // guard matches HTTP bytes. Keep quoted boundaries ASCII-only so both
        // parsers necessarily search for the same delimiter bytes.
        if (code > 0x7e || (code !== 9 && code < 0x20)) {
          return { kind: 'invalid' };
        }
        cursor += 1;
      }
      if (!closed) return { kind: 'invalid' };
    } else {
      const valueStart = cursor;
      while (cursor < contentType.length && HTTP_TOKEN_CHARACTER.test(contentType[cursor] ?? '')) {
        cursor += 1;
      }
      if (cursor === valueStart) return { kind: 'invalid' };
      value = contentType.slice(valueStart, cursor);
    }

    if (name === 'boundary' && boundary === undefined) boundary = value;
  }

  return boundary ? { kind: 'valid', value: boundary } : { kind: 'invalid' };
}

/**
 * Streaming compatibility guard for Busboy 1.6, whose multipart parser ignores
 * its documented `limits.headerPairs` option and hard-codes 2,000 instead.
 *
 * The observer retains only a boundary-sized tail while reading part bodies and
 * at most Busboy's own 16 KiB header block. Multer remains the sole body parser;
 * callers inspect `finish()` from Multer's callback and map a violation onto
 * their route-specific upload error.
 */
class MultipartHeaderPairScanner {
  readonly openingBoundary: Buffer;
  readonly bodyBoundary: Buffer;
  buffer = Buffer.alloc(0);
  state: ScannerState = 'opening-boundary';
  exceeded = false;

  constructor(
    boundary: string,
    readonly limit: number,
  ) {
    this.openingBoundary = Buffer.from(`--${boundary}`, 'latin1');
    this.bodyBoundary = Buffer.from(`\r\n--${boundary}`, 'latin1');
  }

  push(chunk: Buffer | string): void {
    if (this.exceeded) return;
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    this.buffer =
      this.buffer.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.buffer, bytes]);

    let advanced = true;
    while (advanced && !this.exceeded) {
      switch (this.state) {
        case 'opening-boundary':
          advanced = this.consumeOpeningBoundary();
          break;
        case 'headers':
          advanced = this.consumeHeaders();
          break;
        case 'body':
          advanced = this.consumeBodyBoundary();
          break;
        case 'done':
          return;
      }
    }
  }

  private consumeOpeningBoundary(): boolean {
    let searchFrom = 0;
    while (true) {
      const index = this.buffer.indexOf(this.openingBoundary, searchFrom);
      if (index < 0) {
        this.retainTail(this.openingBoundary.length + CRLF.length);
        return false;
      }
      const startsLine =
        index === 0 ||
        (index >= CRLF.length &&
          this.buffer[index - 2] === CRLF[0] &&
          this.buffer[index - 1] === CRLF[1]);
      if (!startsLine) {
        searchFrom = index + 1;
        continue;
      }

      const suffix = index + this.openingBoundary.length;
      if (this.buffer.length < suffix + 2) {
        this.buffer = Buffer.from(this.buffer.subarray(index));
        return false;
      }
      if (this.buffer[suffix] === 45 && this.buffer[suffix + 1] === 45) {
        this.finishScanning();
        return true;
      }
      if (this.buffer[suffix] === CRLF[0] && this.buffer[suffix + 1] === CRLF[1]) {
        this.buffer = Buffer.from(this.buffer.subarray(suffix + CRLF.length));
        this.state = 'headers';
        return true;
      }
      searchFrom = index + 1;
    }
  }

  private consumeHeaders(): boolean {
    const end = this.buffer.indexOf(HEADER_TERMINATOR);
    if (end < 0) {
      if (this.buffer.length > BUSBOY_MAX_HEADER_BYTES) this.markExceeded();
      return false;
    }

    let pairs = 0;
    const lines = this.buffer.subarray(0, end).toString('latin1').split('\r\n');
    for (const line of lines) {
      // Obsolete folded values continue the preceding header rather than
      // consuming another pair, matching Busboy's HeaderParser semantics.
      if (line.startsWith(' ') || line.startsWith('\t')) continue;
      if (line.indexOf(':') <= 0) continue;
      pairs += 1;
      if (pairs > this.limit) {
        this.markExceeded();
        return false;
      }
    }

    this.buffer = Buffer.from(this.buffer.subarray(end + HEADER_TERMINATOR.length));
    this.state = 'body';
    return true;
  }

  private consumeBodyBoundary(): boolean {
    let searchFrom = 0;
    while (true) {
      const index = this.buffer.indexOf(this.bodyBoundary, searchFrom);
      if (index < 0) {
        this.retainTail(this.bodyBoundary.length + 2);
        return false;
      }

      const suffix = index + this.bodyBoundary.length;
      if (this.buffer.length < suffix + 2) {
        this.buffer = Buffer.from(this.buffer.subarray(index));
        return false;
      }
      if (this.buffer[suffix] === 45 && this.buffer[suffix + 1] === 45) {
        this.finishScanning();
        return true;
      }
      if (this.buffer[suffix] === CRLF[0] && this.buffer[suffix + 1] === CRLF[1]) {
        this.buffer = Buffer.from(this.buffer.subarray(suffix + CRLF.length));
        this.state = 'headers';
        return true;
      }

      // Boundary-like bytes inside a part body are ordinary payload unless the
      // marker is followed by CRLF or the closing "--".
      searchFrom = index + CRLF.length;
    }
  }

  private retainTail(length: number): void {
    if (this.buffer.length > length) {
      this.buffer = Buffer.from(this.buffer.subarray(this.buffer.length - length));
    }
  }

  private markExceeded(): void {
    this.exceeded = true;
    this.finishScanning();
  }

  private finishScanning(): void {
    this.state = 'done';
    this.buffer = Buffer.alloc(0);
  }
}

export function observeMultipartHeaderPairs(
  req: Request,
  limit = MULTIPART_HEADER_PAIRS_LIMIT,
): MultipartHeaderPairObservation {
  const rawContentType = req.headers['content-type'];
  const contentType = Array.isArray(rawContentType) ? rawContentType[0] : rawContentType;
  const boundary = multipartBoundary(contentType);
  if (boundary.kind === 'not-multipart') return { finish: () => false };
  if (boundary.kind === 'invalid') return { finish: () => true };

  const scanner = new MultipartHeaderPairScanner(boundary.value, limit);
  const onData = (chunk: Buffer | string): void => scanner.push(chunk);
  req.on('data', onData);

  let observing = true;
  return {
    finish() {
      if (observing) {
        req.removeListener('data', onData);
        observing = false;
      }
      return scanner.exceeded;
    },
  };
}
