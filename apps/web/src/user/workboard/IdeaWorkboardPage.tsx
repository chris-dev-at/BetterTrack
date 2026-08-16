import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';

import {
  IDEA_NAME_MAX,
  IDEA_THESIS_MAX,
  type BacktestPreviewPosition,
  type Idea,
} from '@bettertrack/contracts';

import { getResolvedConglomerate } from '../../lib/conglomerateApi';
import { getIdea, updateIdea } from '../../lib/ideasApi';
import { isConfirmedApiOutcome } from '../../lib/apiClient';
import { useT } from '../../i18n';
import { Skeleton } from '../../ui';
import {
  Button,
  Field,
  Input,
  Page,
  PageHead,
  SectionHead,
  Surface,
  SurfaceBody,
  Textarea,
} from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';
import { usePhoneShell } from '../hooks/useCompactShell';
import { BacktestPanel, type BacktestParams } from './BacktestPanel';

function EditIdeaDialog({ idea, onClose }: { idea: Idea; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState(idea.name);
  const [thesis, setThesis] = useState(idea.thesis ?? '');
  const mutation = useMutation({
    mutationFn: () =>
      updateIdea(idea.id, {
        name: name.trim(),
        thesis: thesis.trim() || null,
      }),
    onSuccess: (response) => {
      queryClient.setQueryData(['idea', idea.id], response);
      void queryClient.invalidateQueries({ queryKey: ['ideas'] });
      void queryClient.invalidateQueries({ queryKey: ['social', 'my-shared'] });
      onClose();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && !mutation.isPending) mutation.mutate();
  }

  return (
    <Dialog phoneSheet onClose={onClose} title={t('workboard.ideas.edit.title')}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field htmlFor="edit-idea-name" label={t('workboard.ideas.save.nameLabel')}>
          <Input
            autoFocus
            id="edit-idea-name"
            maxLength={IDEA_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field htmlFor="edit-idea-thesis" label={t('workboard.ideas.save.thesisLabel')}>
          <Textarea
            id="edit-idea-thesis"
            maxLength={IDEA_THESIS_MAX}
            onChange={(event) => setThesis(event.target.value)}
            rows={4}
            value={thesis}
          />
        </Field>
        {mutation.isError ? <Alert tone="error">{t('workboard.ideas.edit.error')}</Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={mutation.isPending} onClick={onClose} type="button">
            {t('common.cancel')}
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} type="submit" variant="primary">
            {mutation.isPending
              ? t('workboard.ideas.edit.saving')
              : t('workboard.ideas.edit.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * `/workbench/ideas/:ideaId` — reopen a saved idea in the Workboard EXACTLY as it
 * was saved (PROJECTPLAN.md §13.4 V4-P9): the basket (a conglomerate reference OR
 * an ad-hoc weighted set) is resolved back to positions and the backtest params
 * (range / benchmark / late-listing mode / rebalance schedule) seed the panel, so
 * a save → reopen roundtrip is deep-equal by contract. The thesis note is shown
 * above; the same panel carries a "Save as idea" action to re-save any tweaks.
 */
export function IdeaWorkboardPage() {
  const t = useT();
  const { ideaId } = useParams<{ ideaId: string }>();
  const phone = usePhoneShell();
  const [editing, setEditing] = useState(false);

  const ideaQuery = useQuery({
    queryKey: ['idea', ideaId],
    queryFn: ({ signal }) => getIdea(ideaId!, signal),
    enabled: !!ideaId,
  });

  const idea = ideaQuery.data?.idea;
  const source = idea?.state.source;

  // A conglomerate-sourced idea resolves its basket from the referenced
  // conglomerate — via the resolved view, so a NESTED conglomerate (V5-P6)
  // backtests over its flattened effective asset weights; an ad-hoc idea
  // carries the positions inline.
  const conglomerateId = source?.kind === 'conglomerate' ? source.conglomerateId : undefined;
  const conglomerateQuery = useQuery({
    queryKey: ['conglomerate', conglomerateId, 'resolved'],
    queryFn: ({ signal }) => getResolvedConglomerate(conglomerateId!, signal),
    enabled: !!conglomerateId,
  });

  const backLink = (
    <Link className="bt-link" style={{ fontSize: 13 }} to="/workbench/ideas">
      {t('workboard.ideas.open.backLink')}
    </Link>
  );

  if (!ideaId) return null;

  if (ideaQuery.isLoading) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-idea-detail">
        {backLink}
        <PageHead title={t('workboard.ideas.list.title')} />
        <Skeleton height="h-8" width="w-64" />
        <Skeleton height="h-40" />
      </Page>
    );
  }

  if (ideaQuery.isError || !idea || !source) {
    return (
      <Page className="bt-phone-surface bt-workboard-family bt-idea-detail">
        {backLink}
        <PageHead title={t('workboard.ideas.list.title')} />
        <Alert tone="error">{t('workboard.ideas.open.loadError')}</Alert>
        <div>
          <Button onClick={() => void ideaQuery.refetch()}>{t('common.retry')}</Button>
        </div>
      </Page>
    );
  }

  const initialParams: BacktestParams = {
    range: idea.state.range,
    benchmark: idea.state.benchmark,
    mode: idea.state.mode,
    rebalance: idea.state.rebalance,
  };

  let positions: BacktestPreviewPosition[] | null = null;
  if (source.kind === 'adhoc') {
    positions = source.positions.map((p) => ({ assetId: p.assetId, weight: p.weight }));
  } else if (conglomerateQuery.data) {
    positions = conglomerateQuery.data.positions.map((p) => ({
      assetId: p.assetId,
      weight: p.weightPct,
    }));
  }

  return (
    <Page className="bt-phone-surface bt-workboard-family bt-idea-detail">
      {backLink}

      <PageHead
        actions={
          phone ? (
            <Button onClick={() => setEditing(true)} size="sm" variant="neutral">
              {t('workboard.ideas.edit.action')}
            </Button>
          ) : undefined
        }
        title={idea.name}
      />
      {idea.thesis ? (
        <Surface className="bt-idea-thesis" tone="quiet">
          <SurfaceBody>
            <h2 className="bt-label">{t('workboard.ideas.open.thesisHeading')}</h2>
            <p className="bt-soft bt-idea-thesis__copy">{idea.thesis}</p>
          </SurfaceBody>
        </Surface>
      ) : null}

      <section
        aria-label={t('workboard.ideas.open.backtestHeading')}
        className="flex flex-col gap-3"
      >
        <SectionHead title={t('workboard.ideas.open.backtestHeading')} />
        {source.kind === 'conglomerate' && conglomerateQuery.isLoading ? (
          <Skeleton height="h-40" />
        ) : source.kind === 'conglomerate' &&
          conglomerateQuery.isError &&
          isConfirmedApiOutcome(conglomerateQuery.error) ? (
          <Alert tone="info">{t('workboard.ideas.open.conglomerateGone')}</Alert>
        ) : source.kind === 'conglomerate' && conglomerateQuery.isError ? (
          <div className="flex flex-col items-start gap-3">
            <Alert tone="error">{t('workboard.ideas.open.conglomerateLoadError')}</Alert>
            <Button onClick={() => void conglomerateQuery.refetch()}>{t('common.retry')}</Button>
          </div>
        ) : positions ? (
          <BacktestPanel positions={positions} source={source} initialParams={initialParams} />
        ) : null}
      </section>

      {editing ? <EditIdeaDialog idea={idea} onClose={() => setEditing(false)} /> : null}
    </Page>
  );
}
