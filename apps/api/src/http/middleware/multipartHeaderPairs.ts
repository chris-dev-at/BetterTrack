import type { Request } from 'express';

const CRLF = Buffer.from('\r\n');
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n');
const BUSBOY_MAX_HEADER_BYTES = 16 * 1024;

/** Maximum MIME header fields accepted on any one multipart part. */
export const MULTIPART_HEADER_PAIRS_LIMIT = 32;

export interface MultipartHeaderPairObservation {
  /** Detach the raw-stream observer and report whether any part exceeded the limit. */
  finish(): boolean;
}

type ScannerState = 'opening-boundary' | 'headers' | 'body' | 'done';

function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) return null;
  const match = /(?:^|;)\s*boundary\s*=\s*(?:"((?:\\.|[^"])*)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1]?.replace(/\\(.)/g, '$1') ?? match?.[2];
  return boundary ? boundary : null;
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
  if (boundary === null) return { finish: () => false };

  const scanner = new MultipartHeaderPairScanner(boundary, limit);
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
