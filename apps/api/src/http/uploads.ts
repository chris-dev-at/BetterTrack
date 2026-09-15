import type { RequestHandler } from 'express';
import multer, { MulterError, type Options as MulterOptions } from 'multer';

import { IMPORT_MAX_FILE_BYTES } from '@bettertrack/contracts';

import { badRequest } from '../errors';

/**
 * The one multipart budget for the two CSV upload surfaces — `/imports`
 * (PROJECTPLAN.md §13.4 V4-P8) and the retired `/expenses` bank-statement
 * import (§13.5 V5-P9). Both accepted exactly the same shape (one `file` part
 * plus two text fields) and each carried its own copy of this block, which is
 * how a stale `parts` sentinel and a missing `fieldArrayIndexLimit` came to
 * exist in two places at once (#1889, #1929). One definition now; issue #1931
 * requires `git grep fieldArrayIndexLimit apps/api/src` to show exactly one.
 *
 * NOTE: the expenses side is unreachable today. Every upload route below
 * `refuseRetiredExpenseWrite` is a POST, and that gate answers 410 before
 * multer ever runs — cash fusion retired the write surface. These limits are
 * still the only thing standing between a re-opened write path and an unbounded
 * multipart parse, so being dead code buys them nothing: they must stay correct,
 * and they are exercised through the live `/imports` twin that shares them.
 *
 * In-memory storage on purpose: files are capped well below anything worth
 * streaming to disk, and staging wants the text anyway.
 */
export const csvUploadLimits: NonNullable<MulterOptions['limits']> & {
  // `@types/multer@2.2.0` is the latest published and predates multer 2.3.0's
  // new limit, so the intersection names the one key it is missing while every
  // other key stays checked against the published declarations.
  // `fieldNestingDepth` IS declared there and is restated only to make it
  // required, so neither guard can be dropped without a type error.
  fieldArrayIndexLimit: number;
  fieldNestingDepth: number;
} = Object.freeze({
  // `parts` and `fileSize` are NOT sentinels — `fieldSize` still is. Multer
  // 2.3.0 started handing Busboy `parts + 1` and `fileSize + 1`
  // (make-middleware.js) so that its own limits read as "the most that is
  // allowed" rather than "the first value refused"; every other limit is passed
  // through untouched. So `parts: 3` admits exactly the three parts these routes
  // accept (two text fields + one file), and `fileSize: IMPORT_MAX_FILE_BYTES`
  // admits a file of exactly that many bytes and refuses N+1 — both pinned by
  // tests. This used to read `parts: 4`, a sentinel written for the pre-2.3.0
  // semantics, which after the bump quietly admitted a FOURTH part; harmless
  // only because `files: 1` and `fields: 2` are checked before the part count
  // and reject it first.
  fileSize: IMPORT_MAX_FILE_BYTES,
  files: 1,
  fields: 2,
  parts: 3,
  // Still a sentinel: Busboy truncates at equality, so 1,000,001 admits
  // 1,000,000 payload bytes — the machine-generated ASCII maximum the expenses
  // `overrides` contract allows.
  fieldSize: 1_000_001,
  // Declarative only: Busboy 1.6 ignores it and hard-codes MAX_HEADER_PAIRS =
  // 2000 (lib/types/multipart.js:21). The bound that actually holds is its
  // MAX_HEADER_SIZE = 16 KiB per part header block (:22), enforced by a hard
  // `Malformed part header` error (:395-398) and reset per part, so header
  // memory stays under 16 KiB x `parts`. That error is a plain Error, not a
  // MulterError — hence the catch-all mapping in `uploadCsvFile`.
  headerPairs: 32,
  // Multer's opt-in bound for GHSA-535w-7cp7-47q4: `append-field` reads
  // `a[4294967294]` as an array index and materializes a sparse array of that
  // length in `req.body`, and make-middleware checks the index ONLY when
  // `limits` carries the key as an own property — the advisory fix changed
  // nothing for a caller that does not set it.
  //
  // The bound is `index > limit`, not `index >= limit`: at 1 the field names
  // `a[0]` and `a[1]` are still accepted and still build a two-element array.
  // That is deliberate and harmless — neither route accepts an array field at
  // all, so the strict body schema refuses the unknown key a layer later, and
  // what this limit is for is the allocation, which two elements do not make.
  // 0 would shave that to one element and buy nothing. What it does buy is that
  // a 4-billion-entry array is refused where every other multipart breach is,
  // before `req.body` is ever touched.
  fieldArrayIndexLimit: 1,
  // Multer's other opt-in guard, checked before the index bound: the number of
  // `[` in the field name (`a[b][c]` is 2). Neither route accepts a nested
  // field, so 1 leaves every real field name untouched — `portfolioId`,
  // `brokerId`, `bankId`, `overrides` all have none — while refusing the
  // bracket paths `append-field` would otherwise walk into `req.body`.
  fieldNestingDepth: 1,
  // Frozen because multer keeps the reference rather than copying it: without
  // this, any importer could reach in and raise `fileSize` — or delete
  // `fieldArrayIndexLimit`, whose guard multer consults by `hasOwnProperty` —
  // on the live middleware, at runtime, from anywhere in the process. The
  // annotation above still types the object as mutable, which is what multer's
  // published `limits` declaration expects; `Object.freeze` only takes the
  // writability away, and TypeScript does not treat readonly properties as an
  // assignability difference.
});

const upload = multer({ storage: multer.memoryStorage(), limits: csvUploadLimits });

/**
 * `upload.single('file')` with every multipart failure mapped onto the §8
 * envelope, under the caller's own contract error code (`IMPORT_FILE_INVALID`
 * for `/imports`, `EXPENSE_IMPORT_FILE_INVALID` for `/expenses`).
 *
 * Multer wraps only its own limit breaches as `MulterError`; Busboy's framing
 * errors (an over-16 KiB part header block, `Unexpected end of form`, an
 * unparseable content-type) surface as plain `Error`s and would otherwise reach
 * the terminal handler as an opaque 500 — reporting hostile input as a server
 * fault. Every one of them is a malformed upload, so every one of them is the
 * same generic 400; only the file-size breach earns more specific guidance.
 */
export function uploadCsvFile(errorCode: string): RequestHandler {
  return (req, res, next) => {
    upload.single('file')(req, res, (err?: unknown) => {
      if (!err) {
        next();
        return;
      }
      const message =
        err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE'
          ? `The file exceeds the ${Math.round(IMPORT_MAX_FILE_BYTES / (1024 * 1024))} MB upload limit.`
          : 'Invalid file upload.';
      next(badRequest(message, errorCode));
    });
  };
}
