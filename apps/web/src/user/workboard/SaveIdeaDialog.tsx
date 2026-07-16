import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { IDEA_NAME_MAX, IDEA_THESIS_MAX, type IdeaWorkboardState } from '@bettertrack/contracts';

import { createIdea } from '../../lib/ideasApi';
import { useT } from '../../i18n';
import { Dialog } from '../components/Dialog';
import { Alert, Button, TextField } from '../components/ui';

/**
 * "Save as idea" dialog (PROJECTPLAN.md §13.4 V4-P9): persists a named Workboard
 * state — the caller-supplied {@link IdeaWorkboardState} (basket source + backtest
 * params) plus an optional free-text thesis note. On success the idea lands in the
 * Ideas list; the dialog offers a jump there. Sharing is a separate step (the
 * AudiencePicker on the Ideas list / My items) — a new idea is always private.
 */
export function SaveIdeaDialog({
  state,
  onClose,
}: {
  state: IdeaWorkboardState;
  onClose: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [thesis, setThesis] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createIdea({
        name: name.trim(),
        thesis: thesis.trim() ? thesis.trim() : null,
        state,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ideas'] });
      void queryClient.invalidateQueries({ queryKey: ['social', 'my-shared'] });
    },
  });

  const saved = mutation.data?.idea;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  if (saved) {
    return (
      <Dialog title={t('workboard.ideas.save.title')} onClose={onClose}>
        <div className="flex flex-col gap-4">
          <Alert tone="success">
            {t('workboard.ideas.save.successBody', { name: saved.name })}
          </Alert>
          <div className="flex justify-end gap-2">
            <Link to="/workboard/ideas">
              <Button variant="secondary">{t('workboard.ideas.save.viewIdeas')}</Button>
            </Link>
            <Button onClick={onClose}>{t('common.close')}</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('workboard.ideas.save.title')} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label={t('workboard.ideas.save.nameLabel')}
          name="idea-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('workboard.ideas.save.namePlaceholder')}
          maxLength={IDEA_NAME_MAX}
          autoComplete="off"
          autoFocus
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-neutral-300">
            {t('workboard.ideas.save.thesisLabel')}
          </span>
          <textarea
            name="idea-thesis"
            value={thesis}
            onChange={(e) => setThesis(e.target.value)}
            placeholder={t('workboard.ideas.save.thesisPlaceholder')}
            maxLength={IDEA_THESIS_MAX}
            rows={4}
            className="resize-none rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        </label>
        {mutation.isError ? <Alert tone="error">{t('workboard.ideas.save.error')}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={mutation.isPending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim() || mutation.isPending}>
            {mutation.isPending
              ? t('workboard.ideas.save.saving')
              : t('workboard.ideas.save.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
