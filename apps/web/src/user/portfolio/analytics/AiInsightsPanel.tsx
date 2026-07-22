import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { AiInsightFact, AiInsightObservation } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import type { TranslateFn } from '../../../i18n';
import { AI_CAPABILITY_QUERY_KEY, generateInsights, useAiCapability } from '../../../lib/aiApi';
import { ApiError } from '../../../lib/apiClient';
import { formatPercent } from '../../../lib/format';
import { Alert, Button, Spinner } from '../../components/ui';

/**
 * Portfolio "AI insights" block (PROJECTPLAN.md §13.5 V5-P12 2/2). Compact and
 * fold-away (anti-bloat), and HIDDEN ENTIRELY when the capability read says AI is
 * unavailable — the single gate every AI surface keys off. The observations'
 * numbers are service-computed (authoritative); the summary is the local model's
 * plain-language phrasing, framed hard as informational-only, NOT financial
 * advice. There are deliberately no action buttons — nothing here mutates data.
 */
export function AiInsightsPanel({
  portfolioId,
  hasHoldings,
}: {
  portfolioId: string;
  hasHoldings: boolean;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const capability = useAiCapability();

  const mutation = useMutation({
    mutationFn: () => generateInsights({ portfolioId }),
    onSuccess: () => {
      // A completion was spent — refresh the remaining daily budget.
      void queryClient.invalidateQueries({ queryKey: AI_CAPABILITY_QUERY_KEY });
    },
  });

  // The capability read is the single gate: anything but an available provider
  // (loading, error, or disabled) renders NOTHING AI-related.
  if (!capability.data?.available) return null;

  const { dailyCap } = capability.data;
  const remaining = capability.data.remaining;
  const capReached = remaining <= 0;
  const result = mutation.data;

  return (
    <details className="group rounded-lg border border-neutral-800 bg-neutral-900/40">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold text-neutral-200 [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          <span aria-hidden="true">✦</span>
          {t('portfolio.analytics.ai.title')}
        </span>
        <span className="text-xs font-normal text-neutral-500">
          {t('portfolio.analytics.ai.remaining', { remaining, cap: dailyCap })}
        </span>
      </summary>

      <div className="flex flex-col gap-3 border-t border-neutral-800 px-4 py-3">
        <p className="text-xs text-neutral-500">{t('portfolio.analytics.ai.hint')}</p>

        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || capReached || !hasHoldings}
          >
            {result ? t('portfolio.analytics.ai.regenerate') : t('portfolio.analytics.ai.generate')}
          </Button>
          {mutation.isPending ? <Spinner label={t('portfolio.analytics.ai.generating')} /> : null}
        </div>

        {!hasHoldings ? (
          <p className="text-xs text-neutral-500">{t('portfolio.analytics.ai.noData')}</p>
        ) : null}

        {capReached && !mutation.isPending ? (
          <Alert tone="info">{t('portfolio.analytics.ai.capReached')}</Alert>
        ) : null}

        {mutation.isError ? (
          <Alert tone={capExceeded(mutation.error) ? 'info' : 'error'}>
            {capExceeded(mutation.error)
              ? t('portfolio.analytics.ai.capReached')
              : t('portfolio.analytics.ai.error')}
          </Alert>
        ) : null}

        {result ? (
          <div className="flex flex-col gap-3">
            {/* Hard, always-visible framing (§13.5 V5-P12) — informational only. */}
            <p className="rounded-md border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-200/90">
              {t('portfolio.analytics.ai.disclaimer')}
            </p>

            {result.observations.length > 0 ? (
              <div className="flex flex-wrap gap-3">
                {result.observations.map((observation) => (
                  <ObservationCard key={observation.kind} observation={observation} t={t} />
                ))}
              </div>
            ) : null}

            <p className="whitespace-pre-line text-sm text-neutral-200">{result.summary}</p>

            <p className="text-[0.7rem] text-neutral-600">
              {t('portfolio.analytics.ai.model', { model: result.model })} ·{' '}
              {t('portfolio.analytics.ai.spent', { used: dailyCap - remaining, cap: dailyCap })}
            </p>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/** One observation's authoritative, service-computed facts as a compact stat card. */
function ObservationCard({
  observation,
  t,
}: {
  observation: AiInsightObservation;
  t: TranslateFn;
}) {
  return (
    <div className="min-w-[9rem] flex-1 rounded-md border border-neutral-800 bg-neutral-900/60 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
        {t(`portfolio.analytics.ai.observation.${observation.kind}`)}
      </h3>
      <dl className="mt-2 flex flex-col gap-1">
        {observation.facts.map((fact) => (
          <div key={fact.key} className="flex items-baseline justify-between gap-3">
            <dt className="text-xs text-neutral-500">
              {t(`portfolio.analytics.ai.facts.${fact.key}`)}
            </dt>
            <dd className="text-sm font-medium tabular-nums text-neutral-100">
              {formatFactValue(fact)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Percent facts (key ends in `Pct`) format as a locale percentage; counts render plain. */
function formatFactValue(fact: AiInsightFact): string {
  return fact.key.endsWith('Pct') ? formatPercent(fact.value) : String(fact.value);
}

/** True when an error is the typed daily-cap-exhausted case from 1/2. */
function capExceeded(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'AI_CAP_EXCEEDED';
}
