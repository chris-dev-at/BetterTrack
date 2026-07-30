import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { CashTag } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { CASH_TAGS_QUERY_KEY, deleteCashTag, listCashTags } from '../../../lib/cashApi';
import { Alert } from '../../components/ui';
import { EmptyState, Skeleton } from '../../../ui';
import { Badge, Button, PageHead } from '../../../ui/origin';
import { CashTagDialog } from './CashTagDialog';
import { TagChip } from './TagChip';

/**
 * Tag management (V5 cash fusion, `GET`/`POST`/`PATCH`/`DELETE /cash/tags`).
 * Tags are per user (not per portfolio) — usable in any portfolio the caller
 * owns. System tags are app-owned: renameable and re-tintable, never
 * deletable (the delete control simply never renders for one — belt and
 * braces alongside the server's `CASH_TAG_SYSTEM_PROTECTED` refusal). User
 * tags get full CRUD; deleting one cascades its budgets and rule links away,
 * which the delete confirmation states plainly.
 */
export function CashTagsPage() {
  const t = useT();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CashTag | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const tagsQuery = useQuery({
    queryKey: CASH_TAGS_QUERY_KEY,
    queryFn: ({ signal }) => listCashTags(signal),
    staleTime: 30_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteCashTag(id),
    onSuccess: () => {
      setConfirmDeleteId(null);
      void queryClient.invalidateQueries({ queryKey: CASH_TAGS_QUERY_KEY });
    },
  });

  if (tagsQuery.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <Skeleton height="h-8" width="w-48" />
        <Skeleton height="h-24" />
      </div>
    );
  }

  if (tagsQuery.isError || !tagsQuery.data) {
    return <Alert tone="error">{t('cashflow.tags.loadError')}</Alert>;
  }

  const tags = tagsQuery.data.tags;
  const systemTags = tags.filter((tag) => tag.system);
  const userTags = tags.filter((tag) => !tag.system);

  function tagRow(tag: CashTag, deletable: boolean) {
    return (
      <li className="bt-band__row flex flex-wrap items-center gap-3" key={tag.id}>
        <TagChip color={tag.color} name={tag.name} />
        {tag.system ? <Badge>{t('cashflow.tags.systemBadge')}</Badge> : null}
        <span className="flex shrink-0 items-center gap-1" style={{ marginLeft: 'auto' }}>
          <Button onClick={() => setEditing(tag)} size="sm" variant="quiet">
            {t('common.edit')}
          </Button>
          {deletable ? (
            confirmDeleteId === tag.id ? (
              <>
                <span className="bt-muted" style={{ fontSize: 12 }}>
                  {t('cashflow.tags.deleteConfirm', { name: tag.name })}
                </span>
                <Button
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(tag.id)}
                  size="sm"
                  variant="danger"
                >
                  {t('common.confirm')}
                </Button>
                <Button onClick={() => setConfirmDeleteId(null)} size="sm" variant="quiet">
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirmDeleteId(tag.id)} size="sm" variant="danger">
                {t('common.delete')}
              </Button>
            )
          ) : null}
        </span>
      </li>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHead
        actions={
          <Button onClick={() => setCreating(true)} variant="primary">
            {t('cashflow.tags.new')}
          </Button>
        }
        sub={t('cashflow.tags.subtitle')}
        title={t('cashflow.tabs.tags')}
      />

      {tags.length === 0 ? (
        <EmptyState
          cta={
            <Button onClick={() => setCreating(true)} variant="quiet">
              {t('cashflow.tags.emptyCta')}
            </Button>
          }
          description={t('cashflow.tags.emptyDescription')}
          title={t('cashflow.tags.emptyTitle')}
        />
      ) : (
        <>
          {systemTags.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="bt-label">{t('cashflow.tags.systemHeading')}</h2>
              <ul
                className="bt-band flex flex-col"
                style={{ borderBlock: '1px solid var(--bt-border)' }}
              >
                {systemTags.map((tag) => tagRow(tag, false))}
              </ul>
            </div>
          ) : null}
          {userTags.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h2 className="bt-label">{t('cashflow.tags.userHeading')}</h2>
              <ul
                className="bt-band flex flex-col"
                style={{ borderBlock: '1px solid var(--bt-border)' }}
              >
                {userTags.map((tag) => tagRow(tag, true))}
              </ul>
            </div>
          ) : null}
        </>
      )}

      {remove.isError ? <Alert tone="error">{t('cashflow.tags.deleteError')}</Alert> : null}

      {creating ? <CashTagDialog onClose={() => setCreating(false)} /> : null}
      {editing ? <CashTagDialog existing={editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
