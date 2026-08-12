import {
  widgetLayoutDocByteLength,
  WIDGET_LAYOUT_MAX_BYTES,
  WIDGET_LAYOUT_NOT_FOUND_CODE,
  WIDGET_LAYOUT_TOO_LARGE_CODE,
  type WidgetLayoutDoc,
  type WidgetLayoutNamespace,
  type WidgetLayoutResponse,
} from '@bettertrack/contracts';

import { ApiError, notFound } from '../../errors';
import type { WidgetLayoutRepository } from '../../data/repositories/widgetLayoutRepository';

/**
 * Per-account widget compositions, one per client namespace (mobile board #68
 * item 3).
 *
 * A verbatim store by design: the widget vocabulary belongs to the clients and
 * changes with every one of their deploys, so this service persists and returns
 * the document without interpreting a single field. It enforces exactly two
 * things the contract could not:
 *
 *  - SIZE. Checked here rather than inside the request schema so a breach
 *    answers `413 WIDGET_LAYOUT_TOO_LARGE` — an actionable, distinct signal —
 *    instead of collapsing into a generic `400 VALIDATION_ERROR` alongside
 *    "that wasn't an object". Measured on the serialised UTF-8 bytes because
 *    that is what actually gets stored.
 *  - EXISTENCE. A namespace with no row is a `404 WIDGET_LAYOUT_NOT_FOUND`, not
 *    an empty document, so a client can tell "adopt my local default" apart
 *    from "the user deliberately saved an empty board".
 *
 * Every operation is `userId`-scoped in the repository (§10); the id always
 * comes from the authenticated principal, never from the request.
 */
export interface WidgetLayoutServiceDeps {
  widgetLayoutRepo: WidgetLayoutRepository;
}

export interface WidgetLayoutService {
  /** The caller's composition for one namespace; throws 404 when never saved. */
  get(userId: string, namespace: WidgetLayoutNamespace): Promise<WidgetLayoutResponse>;
  /** Replace the caller's composition for one namespace (last write wins). */
  set(
    userId: string,
    namespace: WidgetLayoutNamespace,
    doc: WidgetLayoutDoc,
  ): Promise<WidgetLayoutResponse>;
}

/** `413` — the document is larger than the server will store. */
function tooLarge(bytes: number): ApiError {
  return new ApiError(
    413,
    WIDGET_LAYOUT_TOO_LARGE_CODE,
    `The widget layout must serialise to at most ${WIDGET_LAYOUT_MAX_BYTES} bytes (received ${bytes}).`,
  );
}

export function createWidgetLayoutService(deps: WidgetLayoutServiceDeps): WidgetLayoutService {
  const { widgetLayoutRepo } = deps;

  return {
    async get(userId, namespace) {
      const row = await widgetLayoutRepo.find(userId, namespace);
      if (!row) {
        throw notFound('No widget layout saved for this namespace.', WIDGET_LAYOUT_NOT_FOUND_CODE);
      }
      return {
        // Cast rather than re-parse: the document was validated on the way in,
        // and re-validating on read would let a cap tightened in a later build
        // turn an already-stored composition into a 500 for its owner.
        doc: row.doc as WidgetLayoutDoc,
        updatedAt: row.updatedAt.toISOString(),
      };
    },

    async set(userId, namespace, doc) {
      const bytes = widgetLayoutDocByteLength(doc);
      if (bytes > WIDGET_LAYOUT_MAX_BYTES) throw tooLarge(bytes);
      const row = await widgetLayoutRepo.upsert(userId, namespace, doc);
      return { doc: row.doc as WidgetLayoutDoc, updatedAt: row.updatedAt.toISOString() };
    },
  };
}
