import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';

import { CREATE_INTENT_PARAM, type CreateIntent } from '../routeParams';

/**
 * Start a create flow the user asked for somewhere else (#1071).
 *
 * The global "+ Create" menu and the ⌘K palette are links, not buttons: they can
 * only navigate, so the destination page is what opens the dialog. Every such
 * page runs the same three steps — read the flag, start the flow, consume the
 * flag with `replace: true` so closing the dialog or pressing Back cannot
 * reopen it — which is this hook, once, instead of six copies drifting apart.
 *
 * Consuming keeps the rest of the query string (`?portfolio=<id>` above all).
 *
 * @param intent the value this surface answers to — see {@link CREATE_INTENT},
 *   which documents the whole namespace and why the values must not collide
 * @param start opens the flow; called at most once per arrival
 * @param ready hold the intent until the page can actually run it (a form that
 *   needs its list loaded before focusing a field). The flag survives until
 *   then, so nothing is lost.
 */
export function useCreateIntent(intent: CreateIntent, start: () => void, ready = true): void {
  const [searchParams, setSearchParams] = useSearchParams();
  // The callback is written inline at every call site, so it is a new function
  // on every render; keeping it out of the dependency list is what stops this
  // effect from re-running on renders that have nothing to do with the URL.
  const startRef = useRef(start);
  useEffect(() => {
    startRef.current = start;
  });

  useEffect(() => {
    if (!ready) return;
    if (searchParams.get(CREATE_INTENT_PARAM) !== intent) return;
    startRef.current();
    const next = new URLSearchParams(searchParams);
    next.delete(CREATE_INTENT_PARAM);
    setSearchParams(next, { replace: true });
  }, [intent, ready, searchParams, setSearchParams]);
}
