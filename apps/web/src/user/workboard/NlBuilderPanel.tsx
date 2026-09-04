import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { AiConglomerateDraftLine } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { AI_CAPABILITY_QUERY_KEY, draftConglomerate, useAiCapability } from '../../lib/aiApi';
import { ApiError } from '../../lib/apiClient';
import { formatWeight } from '../../lib/format';
import { Alert, Button } from '../components/ui';
import { positionsFromDraftLines, type BuilderPosition } from './conglomerateBuilder';

/** The prompt is capped server-side (`aiConglomerateDraftRequestSchema`) at 1000 chars. */
const MAX_PROMPT_LEN = 1000;

/** A returned draft, held here until the user explicitly confirms or discards it. */
interface PendingDraft {
  positions: BuilderPosition[];
  unresolved: AiConglomerateDraftLine[];
}

/**
 * Natural-language Conglomerate Builder (PROJECTPLAN.md §13.5 V5-P12 2/2, §6.5).
 * Compact and fold-away (anti-bloat), HIDDEN ENTIRELY unless the capability read
 * says AI is available. The model only extracts weighted intents; assets are
 * resolved exclusively through the LOCAL search catalog server-side.
 *
 * The output is ALWAYS a user-confirmed draft: a returned basket is held HERE, in
 * panel-local state, and never touches the Builder's positions — the state the
 * autosave persists — until the user presses Apply. Everything they need for that
 * decision (the resolved weights, the intents that found no catalog match, and,
 * when the Builder already holds a basket, exactly what would be replaced) is on
 * screen BEFORE the confirmation, and Discard leaves the saved blueprint
 * byte-identical because no write ever happened.
 */
export function NlBuilderPanel({
  onApply,
  targetName,
  targetPositionCount,
}: {
  onApply: (positions: BuilderPosition[]) => void;
  /** The basket being edited — named in the replace confirmation. */
  targetName: string;
  /** How many positions Apply would replace (0 ⇒ nothing is at stake). */
  targetPositionCount: number;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const capability = useAiCapability();
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<PendingDraft | null>(null);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => draftConglomerate({ prompt: text }),
    onSuccess: (draft) => {
      setAppliedCount(null);
      setPending({
        positions: positionsFromDraftLines(draft.lines),
        // Resolution never drops a line — unmatched intents are surfaced, not lost.
        unresolved: draft.lines.filter((line) => line.asset === null),
      });
      void queryClient.invalidateQueries({ queryKey: AI_CAPABILITY_QUERY_KEY });
    },
  });

  // The capability read is the single gate — unavailable ⇒ render NOTHING.
  if (!capability.data?.available) return null;

  const remaining = capability.data.remaining;
  const capReached = remaining <= 0;
  const trimmed = prompt.trim();

  /** The ONLY path from a draft into Builder state — an explicit user action. */
  function applyPending() {
    if (!pending) return;
    onApply(pending.positions);
    setAppliedCount(pending.positions.length);
    setPending(null);
  }

  /** Dismissal: the draft is dropped and nothing was ever written. */
  function discardPending() {
    setPending(null);
    setAppliedCount(null);
    mutation.reset();
  }

  return (
    <details className="bt-panel">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium bt-soft [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span aria-hidden="true">✦</span>
          {t('workboard.builder.ai.title')}
        </span>
        <span className="text-xs font-normal bt-muted">
          {t('workboard.builder.ai.remaining', { remaining, cap: capability.data.dailyCap })}
        </span>
      </summary>

      <div className="flex flex-col gap-2 bt-t-rule p-3">
        <p className="text-xs bt-muted">{t('workboard.builder.ai.hint')}</p>
        <label className="sr-only" htmlFor="nl-builder-prompt">
          {t('workboard.builder.ai.title')}
        </label>
        <textarea
          id="nl-builder-prompt"
          value={prompt}
          maxLength={MAX_PROMPT_LEN}
          rows={2}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('workboard.builder.ai.placeholder')}
          className="bt-textarea w-full"
        />

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => mutation.mutate(trimmed)}
            disabled={mutation.isPending || capReached || trimmed.length === 0}
          >
            {mutation.isPending
              ? t('workboard.builder.ai.generating')
              : t('workboard.builder.ai.submit')}
          </Button>
        </div>

        {capReached && !mutation.isPending ? (
          <Alert tone="info">{t('workboard.builder.ai.capReached')}</Alert>
        ) : null}

        {mutation.isError ? (
          <Alert tone={capExceeded(mutation.error) ? 'info' : 'error'}>
            {capExceeded(mutation.error)
              ? t('workboard.builder.ai.capReached')
              : t('workboard.builder.ai.error')}
          </Alert>
        ) : null}

        {/* The review step. Nothing below has touched Builder state yet. */}
        {pending ? (
          <div
            aria-label={t('workboard.builder.ai.reviewTitle')}
            className="flex flex-col gap-2 bt-panel bt-panel--soft p-3"
            role="group"
          >
            <p className="text-xs font-medium">
              {t('workboard.builder.ai.reviewDraft', { count: pending.positions.length })}
            </p>

            {pending.positions.length > 0 ? (
              <ul className="flex flex-col gap-1 text-xs">
                {pending.positions.map((position) => (
                  <li className="flex items-baseline justify-between gap-3" key={position.refId}>
                    <span className="truncate">{position.symbol}</span>
                    <span className="bt-num">{formatWeight(position.weightPct)}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Unresolved intents are named BEFORE the decision, never after it. */}
            {pending.unresolved.length > 0 ? (
              <div
                className="bt-badge bt-badge--gold block px-3 py-2 text-xs"
                style={{ borderRadius: 6 }}
              >
                <p className="font-medium">{t('workboard.builder.ai.unresolved')}</p>
                <ul className="mt-1 list-disc pl-4">
                  {pending.unresolved.map((line, index) => (
                    <li key={`${line.query}-${index}`}>{line.query}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {targetPositionCount > 0 ? (
              <p
                className="bt-badge bt-badge--gold block px-3 py-2 text-xs font-medium"
                style={{ borderRadius: 6 }}
              >
                {t('workboard.builder.ai.replaceWarning', {
                  count: targetPositionCount,
                  name: targetName,
                })}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {/* A draft whose every intent went unresolved has nothing to apply
                  — applying it would only wipe the basket, so the button that
                  does that is not offered. Discard is the only way out. */}
              <Button
                type="button"
                variant="primary"
                onClick={applyPending}
                disabled={pending.positions.length === 0}
              >
                {t('workboard.builder.ai.apply')}
              </Button>
              <Button type="button" variant="secondary" onClick={discardPending}>
                {t('workboard.builder.ai.discard')}
              </Button>
            </div>
            <p className="text-[0.7rem] bt-muted">{t('workboard.builder.ai.nothingSavedYet')}</p>
          </div>
        ) : null}

        {appliedCount !== null ? (
          <p className="text-xs bt-pos">
            {t('workboard.builder.ai.applied', { count: appliedCount })}
          </p>
        ) : null}

        {/* The same hard framing every AI surface carries (§6.18) — this one emits
            a weighted allocation, so it is the surface that needs it most. */}
        <p className="bt-badge bt-badge--gold px-3 py-2 text-xs" style={{ borderRadius: 6 }}>
          {t('workboard.builder.ai.notAdvice')}
        </p>
        <p className="text-[0.7rem] bt-muted">{t('workboard.builder.ai.disclaimer')}</p>
      </div>
    </details>
  );
}

/** True when an error is the typed daily-cap-exhausted case from 1/2. */
function capExceeded(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'AI_CAP_EXCEEDED';
}
