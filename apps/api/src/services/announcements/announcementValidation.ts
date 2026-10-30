import {
  ANNOUNCEMENT_ERROR_CODES,
  announcementBodyMaxChars,
  findForbiddenAnnouncementChar,
  parseAnnouncementBody,
  type AnnouncementBodyFormat,
  type AnnouncementKind,
} from '@bettertrack/contracts';

import type { AnnouncementRow } from '../../data/schema';
import { badRequest, conflict } from '../../errors';

/**
 * The save- and publish-time rules of an announcement's content and fields
 * (PROJECTPLAN §6.19.4, §6.19.6; contract §3.4, §7.2, §7.3). Pure: each
 * function either returns or throws the contract's error.
 */

export interface AnnouncementContent {
  kind: AnnouncementKind;
  format: AnnouncementBodyFormat;
  titleEn: string;
  bodyEn: string;
  titleDe: string | null;
  bodyDe: string | null;
}

const TEXT_FIELDS = ['titleEn', 'bodyEn', 'titleDe', 'bodyDe'] as const;

/**
 * Contract §3.4 on every save: no forbidden character in any title or body
 * (`400 ANNOUNCEMENT_TEXT_INVALID`), each body within its kind's limit and
 * inside the grammar (`400 ANNOUNCEMENT_BODY_INVALID`, `details.issues`
 * naming field, line and column).
 */
export function assertAnnouncementContent(content: AnnouncementContent): void {
  for (const field of TEXT_FIELDS) {
    const value = content[field];
    if (value === null) continue;
    const hit = findForbiddenAnnouncementChar(value);
    if (hit) {
      throw badRequest(
        `${field} contains a forbidden control or bidirectional character (${hit.codePoint}).`,
        ANNOUNCEMENT_ERROR_CODES.textInvalid,
        { field, ...hit },
      );
    }
  }
  const issues: Array<Record<string, unknown>> = [];
  const max = announcementBodyMaxChars(content.kind);
  for (const field of ['bodyEn', 'bodyDe'] as const) {
    const body = content[field];
    if (body === null) continue;
    if (body.length > max) {
      issues.push({
        field,
        code: 'too_long',
        line: 1,
        column: 1,
        message: `A ${content.kind} body may contain at most ${max} characters.`,
      });
      continue;
    }
    for (const issue of parseAnnouncementBody(body, content.format).issues) {
      issues.push({ field, ...issue });
    }
  }
  if (issues.length > 0) {
    throw badRequest('The announcement body is not valid.', ANNOUNCEMENT_ERROR_CODES.bodyInvalid, {
      issues: issues.slice(0, 50),
    });
  }
}

/** Publish (contract §7.2): EN always, DE as well for ack_required. */
export function assertAnnouncementComplete(row: AnnouncementRow): void {
  const missing: string[] = [];
  if (!row.titleEn.trim()) missing.push('titleEn');
  if (!row.bodyEn.trim()) missing.push('bodyEn');
  if (row.kind === 'ack_required') {
    if (!row.titleDe?.trim()) missing.push('titleDe');
    if (!row.bodyDe?.trim()) missing.push('bodyDe');
  }
  if (missing.length > 0) {
    throw badRequest(
      'The announcement is missing required content.',
      ANNOUNCEMENT_ERROR_CODES.incomplete,
      { missing },
    );
  }
}

/** `400 INVALID_ANNOUNCEMENT_WINDOW`: an end at or before now, or before the start. */
export function assertWindow(
  startsAt: Date | null,
  endsAt: Date | null,
  at: Date,
  requireFutureEnd: boolean,
): void {
  if (endsAt && startsAt && endsAt.getTime() < startsAt.getTime()) {
    throw badRequest(
      'endsAt must be at or after startsAt.',
      ANNOUNCEMENT_ERROR_CODES.invalidWindow,
    );
  }
  if (requireFutureEnd && endsAt && endsAt.getTime() <= at.getTime()) {
    throw badRequest('endsAt must lie in the future.', ANNOUNCEMENT_ERROR_CODES.invalidWindow);
  }
}

/** Fields locked for every kind once published (contract §7.3). */
const LOCKED_AFTER_PUBLISH = [
  'kind',
  'audience',
  'startsAt',
  'notifyByEmail',
  'notifyByEmailAfterDays',
] as const;
/** ack_required additionally freezes its text: only `endsAt` moves. */
const ACK_TEXT_FIELDS = ['severity', 'titleEn', 'bodyEn', 'titleDe', 'bodyDe'] as const;

export type PatchableField =
  | (typeof LOCKED_AFTER_PUBLISH)[number]
  | (typeof ACK_TEXT_FIELDS)[number]
  | 'endsAt';

/**
 * `409 ANNOUNCEMENT_FIELD_LOCKED` (`details.fields`) for a CHANGE to a field
 * locked in this row's state. Sending a locked field with its current value
 * is not a change.
 */
export function assertNoLockedChange(
  row: AnnouncementRow,
  changed: readonly PatchableField[],
): void {
  if (row.lifecycle === 'draft') return;
  const locked = new Set<PatchableField>([
    ...LOCKED_AFTER_PUBLISH,
    ...(row.kind === 'ack_required' ? ACK_TEXT_FIELDS : []),
  ]);
  const fields = changed.filter((field) => locked.has(field));
  if (fields.length > 0) {
    throw conflict(
      'These fields can no longer be changed once the announcement is published.',
      ANNOUNCEMENT_ERROR_CODES.fieldLocked,
      { fields },
    );
  }
}

/** `409 ANNOUNCEMENT_ENDED`: archived, or published with its end passed — archive only. */
export function assertEditable(row: AnnouncementRow, at: Date): void {
  const ended =
    row.lifecycle === 'archived' ||
    (row.lifecycle === 'published' && row.endsAt !== null && row.endsAt.getTime() <= at.getTime());
  if (ended) {
    throw conflict(
      'This announcement has ended; only archiving is possible.',
      ANNOUNCEMENT_ERROR_CODES.ended,
    );
  }
}
