import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { IDEA_NAME_MAX, IDEA_THESIS_MAX, type IdeaWorkboardState } from '@bettertrack/contracts';

import { createIdea } from '../../lib/ideasApi';
import { useT } from '../../i18n';
import { Button, Field, Input, Textarea } from '../../ui/origin';
import { Dialog } from '../components/Dialog';
import { Alert } from '../components/ui';

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
          <Alert tone="success">{t('workboard.ideas.save.successBody', { name: saved.name })}</Alert>
          <div className="flex justify-end gap-2">
            <Link to="/workbench/ideas">
              <Button>{t('workboard.ideas.save.viewIdeas')}</Button>
            </Link>
            <Button onClick={onClose} variant="primary">
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={t('workboard.ideas.save.title')} onClose={onClose}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field htmlFor="idea-name" label={t('workboard.ideas.save.nameLabel')}>
          <Input
            autoComplete="off"
            autoFocus
            id="idea-name"
            maxLength={IDEA_NAME_MAX}
            name="idea-name"
            onChange={(e) => setName(e.target.value)}
            placeholder={t('workboard.ideas.save.namePlaceholder')}
            value={name}
          />
        </Field>
        <Field htmlFor="idea-thesis" label={t('workboard.ideas.save.thesisLabel')}>
          <Textarea
            id="idea-thesis"
            maxLength={IDEA_THESIS_MAX}
            name="idea-thesis"
            onChange={(e) => setThesis(e.target.value)}
            placeholder={t('workboard.ideas.save.thesisPlaceholder')}
            rows={4}
            style={{ resize: 'none' }}
            value={thesis}
          />
        </Field>
        {mutation.isError ? <Alert tone="error">{t('workboard.ideas.save.error')}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={mutation.isPending} onClick={onClose} type="button">
            {t('common.cancel')}
          </Button>
          <Button disabled={!name.trim() || mutation.isPending} type="submit" variant="primary">
            {mutation.isPending ? t('workboard.ideas.save.saving') : t('workboard.ideas.save.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
