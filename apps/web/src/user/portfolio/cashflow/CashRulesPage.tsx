import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import type { CashRule, CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import {
  applyCashRules,
  CASH_RULES_QUERY_KEY,
  CASH_TAGS_QUERY_KEY,
  deleteCashRule,
  listCashRules,
  listCashTags,
} from '../../../lib/cashApi';
import { Alert } from '../../components/ui';
import { EmptyState, Skeleton } from '../../../ui';
import { Badge, Button } from '../../../ui/origin';
import { SectionHead } from './SectionHead';
import { CashRuleDialog } from './CashRuleDialog';
import { TagChip } from './TagChip';

/**
 * Auto-tagging rules (V5 cash fusion, `GET`/`POST`/`PATCH`/`DELETE
 * /cash/rules`). A rule tests a movement's note and, on a match, applies
 * every one of its tags at once. Rules run in ascending priority and the
 * FIRST match wins — stated once here, not per row.
 */
export function CashRulesPage({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CashRule | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: CASH_RULES_QUERY_KEY,
    queryFn: ({ signal }) => listCashRules(signal),
    staleTime: 30_000,
  });
  const tagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    staleTime: 30_000,
  });

  const tags = useMemo(() => tagsQuery.data?.tags ?? [], [tagsQuery.data]);
  const tagsById = useMemo(
    () => new Map<string, CashTag>(tags.map((tag) => [tag.id, tag])),
    [tags],
  );

  const remove = useMutation({
    mutationFn: (id: string) => deleteCashRule(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: CASH_RULES_QUERY_KEY });
    },
  });

  /**
   * Rules only tag movements booked AFTER they exist, and a rule is usually
   * written after the movements it describes. This is the catch-up: additive,
   * so it can never remove a tag set by hand, which is why it is a button
   * rather than something that happens on save.
   */
  const applyToExisting = useMutation({
    mutationFn: () => applyCashRules(),
    onSuccess: () => {
      // Every movement list and every tag-derived total may have moved.
      void queryClient.invalidateQueries({ queryKey: ['portfolio'] });
      void queryClient.invalidateQueries({ queryKey: ['cash'] });
    },
  });

  const rules = rulesQuery.data?.rules ?? [];
  const isLoading = rulesQuery.isPending || tagsQuery.isPending;
  const hasLoadError = rulesQuery.isError || tagsQuery.isError;

  function retryPrerequisites() {
    if (rulesQuery.isError) void rulesQuery.refetch();
    if (tagsQuery.isError) void tagsQuery.refetch();
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-14" />
        <Skeleton height="h-14" />
      </div>
    );
  }

  if (hasLoadError) {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="error">{t('cashflow.rules.loadError')}</Alert>
        <div>
          <Button
            disabled={rulesQuery.isFetching || tagsQuery.isFetching}
            onClick={retryPrerequisites}
          >
            {t('common.retry')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="bt-money-surface flex flex-col gap-6">
      <SectionHead
        action={
          <>
            {rules.length > 0 ? (
              <Button
                disabled={applyToExisting.isPending}
                onClick={() => applyToExisting.mutate()}
                variant="quiet"
              >
                {applyToExisting.isPending
                  ? t('cashflow.rules.applying')
                  : t('cashflow.rules.applyToExisting')}
              </Button>
            ) : null}
            <Button
              disabled={tags.length === 0}
              onClick={() => setCreating(true)}
              variant="primary"
            >
              {t('cashflow.rules.new')}
            </Button>
          </>
        }
        embedded={embedded}
        sub={t('cashflow.rules.subtitle')}
        title={t('cashflow.tabs.rules')}
      />

      {applyToExisting.isSuccess ? (
        <Alert tone="success">
          {applyToExisting.data.movementsTagged === 0
            ? t('cashflow.rules.applyNoneTagged')
            : t('cashflow.rules.applyTagged', { count: applyToExisting.data.movementsTagged })}
        </Alert>
      ) : null}
      {applyToExisting.isError ? (
        <Alert tone="error">{t('cashflow.rules.applyError')}</Alert>
      ) : null}

      {rules.length === 0 ? (
        <EmptyState
          description={t('cashflow.rules.emptyDescription')}
          title={t('cashflow.rules.emptyTitle')}
        />
      ) : (
        <ul className="bt-band flex flex-col" style={{ borderBlock: '1px solid var(--bt-border)' }}>
          {rules.map((rule) => {
            const ruleTags = rule.tagIds
              .map((id) => tagsById.get(id))
              .filter((tag): tag is CashTag => tag !== undefined);
            return (
              <li className="bt-band__row flex flex-wrap items-center gap-3" key={rule.id}>
                <div className="min-w-0 flex-1">
                  <p className="bt-row-title flex flex-wrap items-center gap-1.5">
                    <span className="bt-muted">{t(`cashflow.matchType.${rule.matchType}`)}</span>
                    <span>“{rule.pattern}”</span>
                    {!rule.enabled ? <Badge>{t('cashflow.rules.disabled')}</Badge> : null}
                    <span className="bt-meta">
                      {t('cashflow.rules.priorityLabel', { priority: rule.priority })}
                    </span>
                  </p>
                  <p
                    className="bt-row-sub flex flex-wrap items-center gap-1.5"
                    style={{ marginTop: 4 }}
                  >
                    <span aria-hidden="true">→</span>
                    {ruleTags.length === 0 ? (
                      <span>{t('cashflow.rules.unknownTag')}</span>
                    ) : (
                      ruleTags.map((tag) => (
                        <TagChip color={tag.color} key={tag.id} name={tag.name} />
                      ))
                    )}
                  </p>
                </div>
                {confirmDeleteId === rule.id ? (
                  <span className="bt-row-actions flex shrink-0 items-center gap-1">
                    <Button
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(rule.id)}
                      size="sm"
                      variant="danger"
                    >
                      {t('common.confirm')}
                    </Button>
                    <Button onClick={() => setConfirmDeleteId(null)} size="sm" variant="quiet">
                      {t('common.cancel')}
                    </Button>
                  </span>
                ) : (
                  <span className="bt-row-actions flex shrink-0 items-center gap-1">
                    <Button onClick={() => setEditing(rule)} size="sm" variant="quiet">
                      {t('common.edit')}
                    </Button>
                    <Button onClick={() => setConfirmDeleteId(rule.id)} size="sm" variant="danger">
                      {t('common.delete')}
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {remove.isError ? <Alert tone="error">{t('cashflow.rules.deleteError')}</Alert> : null}

      {creating ? <CashRuleDialog onClose={() => setCreating(false)} tags={tags} /> : null}
      {editing ? (
        <CashRuleDialog existing={editing} onClose={() => setEditing(null)} tags={tags} />
      ) : null}
    </div>
  );
}
