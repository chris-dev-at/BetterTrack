import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { AiConglomerateDraftLine } from '@bettertrack/contracts';

import { useT } from '../../i18n';
import { AI_CAPABILITY_QUERY_KEY, draftConglomerate, useAiCapability } from '../../lib/aiApi';
import { ApiError } from '../../lib/apiClient';
import { Alert, Button } from '../components/ui';
import { positionsFromDraftLines, type BuilderPosition } from './conglomerateBuilder';

/** The prompt is capped server-side (`aiConglomerateDraftRequestSchema`) at 1000 chars. */
const MAX_PROMPT_LEN = 1000;

/**
 * Natural-language Conglomerate Builder (PROJECTPLAN.md §13.5 V5-P12 2/2).
 * Compact and fold-away (anti-bloat), HIDDEN ENTIRELY unless the capability read
 * says AI is available. The model only extracts weighted intents; assets are
 * resolved exclusively through the LOCAL search catalog server-side. The output
 * is always a DRAFT — it prefills the normal Builder positions (which the user
 * reviews, edits and explicitly saves); unresolved intents are flagged here and
 * never silently dropped.
 */
export function NlBuilderPanel({ onApply }: { onApply: (positions: BuilderPosition[]) => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const capability = useAiCapability();
  const [prompt, setPrompt] = useState('');
  const [unresolved, setUnresolved] = useState<AiConglomerateDraftLine[]>([]);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const mutation = useMutation({
    mutationFn: (text: string) => draftConglomerate({ prompt: text }),
    onSuccess: (draft) => {
      const positions = positionsFromDraftLines(draft.lines);
      onApply(positions);
      setAppliedCount(positions.length);
      // Resolution never drops a line — unmatched intents are surfaced, not lost.
      setUnresolved(draft.lines.filter((line) => line.asset === null));
      void queryClient.invalidateQueries({ queryKey: AI_CAPABILITY_QUERY_KEY });
    },
  });

  // The capability read is the single gate — unavailable ⇒ render NOTHING.
  if (!capability.data?.available) return null;

  const remaining = capability.data.remaining;
  const capReached = remaining <= 0;
  const trimmed = prompt.trim();

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

        {mutation.isSuccess ? (
          <>
            <p className="text-xs bt-pos">
              {t('workboard.builder.ai.applied', { count: appliedCount ?? 0 })}
            </p>
            {unresolved.length > 0 ? (
              <div className="bt-badge bt-badge--gold block px-3 py-2 text-xs" style={{ borderRadius: 6 }}>
                <p className="font-medium">{t('workboard.builder.ai.unresolved')}</p>
                <ul className="mt-1 list-disc pl-4">
                  {unresolved.map((line, index) => (
                    <li key={`${line.query}-${index}`}>{line.query}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}

        <p className="text-[0.7rem] bt-muted">{t('workboard.builder.ai.disclaimer')}</p>
      </div>
    </details>
  );
}

/** True when an error is the typed daily-cap-exhausted case from 1/2. */
function capExceeded(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'AI_CAP_EXCEEDED';
}
