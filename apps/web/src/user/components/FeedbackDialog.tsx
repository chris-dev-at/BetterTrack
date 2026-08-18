import { useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';

import {
  FEEDBACK_MESSAGE_MAX_LENGTH,
  FEEDBACK_SUBJECT_MAX_LENGTH,
  type CreateFeedbackRequest,
  type FeedbackCategory,
} from '@bettertrack/contracts';

import { useI18n, useT } from '../../i18n';
import { ApiError } from '../../lib/apiClient';
import { submitFeedback } from '../../lib/feedbackApi';
import { Button, Field, Input, Select, Textarea } from '../../ui/origin';
import { Alert } from './ui';
import { Dialog } from './Dialog';

type SubmissionState = 'idle' | 'pending' | 'success' | 'error';

/** The three API categories, kept in the server's triage order. */
const CATEGORIES: readonly FeedbackCategory[] = ['feature', 'bug', 'other'];

function hasValidationFieldError(details: unknown, field: string): boolean {
  if (typeof details !== 'object' || details === null || !('fieldErrors' in details)) return false;

  const fieldErrors = details.fieldErrors;
  return (
    typeof fieldErrors === 'object' &&
    fieldErrors !== null &&
    field in fieldErrors &&
    Array.isArray(fieldErrors[field]) &&
    fieldErrors[field].length > 0
  );
}

function feedbackErrorMessage(t: ReturnType<typeof useT>, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_ERROR') {
      if (hasValidationFieldError(error.details, 'message')) {
        return t('feedback.messageTooLong', { max: FEEDBACK_MESSAGE_MAX_LENGTH });
      }
      if (hasValidationFieldError(error.details, 'subject')) {
        return t('feedback.subjectTooLong', { max: FEEDBACK_SUBJECT_MAX_LENGTH });
      }
      if (hasValidationFieldError(error.details, 'category')) return t('feedback.categoryRequired');
    }

    // API errors with a dedicated message (for example, rate limits) remain
    // useful. The validation envelope itself is deliberately generic, so its
    // field details above provide the user-facing copy instead.
    if (error.message && error.message !== 'Invalid request.') return error.message;
  }
  return t('feedback.submitError');
}

/**
 * A focused, text-only reporter. It deliberately owns no navigation: Settings
 * and the Developer hub both open this same dialog, so the user returns to the
 * context in which the report started.
 */
export function FeedbackDialog({ onClose, screen }: { onClose: () => void; screen?: string }) {
  const t = useT();
  const { locale } = useI18n();
  const location = useLocation();
  const [category, setCategory] = useState<FeedbackCategory | ''>('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [state, setState] = useState<SubmissionState>('idle');
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const normalizedSubject = subject.trim();
  const normalizedMessage = message.trim();

  const categoryError = attempted && category === '' ? t('feedback.categoryRequired') : undefined;
  const subjectError =
    normalizedSubject.length > FEEDBACK_SUBJECT_MAX_LENGTH
      ? t('feedback.subjectTooLong', { max: FEEDBACK_SUBJECT_MAX_LENGTH })
      : undefined;
  const messageError =
    normalizedMessage.length > FEEDBACK_MESSAGE_MAX_LENGTH
      ? t('feedback.messageTooLong', { max: FEEDBACK_MESSAGE_MAX_LENGTH })
      : attempted && normalizedMessage.length === 0
        ? t('feedback.messageRequired')
        : undefined;

  function resumeEditing() {
    if (state === 'error') {
      setState('idle');
      setSubmissionError(null);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAttempted(true);

    if (
      category === '' ||
      normalizedSubject.length > FEEDBACK_SUBJECT_MAX_LENGTH ||
      normalizedMessage.length === 0 ||
      normalizedMessage.length > FEEDBACK_MESSAGE_MAX_LENGTH ||
      state === 'pending'
    ) {
      return;
    }

    const body: CreateFeedbackRequest = {
      category,
      message: normalizedMessage,
      ...(normalizedSubject === '' ? {} : { subject: normalizedSubject }),
      context: {
        platform: 'web',
        appVersion: typeof __APP_RELEASE__ === 'string' ? __APP_RELEASE__ : 'unknown',
        browser: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
        locale,
        screen: screen ?? `${location.pathname}${location.search}${location.hash}`,
      },
    };

    setState('pending');
    setSubmissionError(null);
    try {
      await submitFeedback(body);
      setState('success');
    } catch (error) {
      setSubmissionError(feedbackErrorMessage(t, error));
      setState('error');
    }
  }

  if (state === 'success') {
    return (
      <Dialog
        description={t('feedback.dialogDescription')}
        onClose={onClose}
        phoneSheet
        title={t('feedback.title')}
      >
        <div className="flex flex-col gap-4">
          <Alert tone="success">{t('feedback.success')}</Alert>
          <div className="flex justify-end">
            <Button onClick={onClose} variant="primary">
              {t('common.close')}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }

  const pending = state === 'pending';

  return (
    <Dialog
      description={t('feedback.dialogDescription')}
      onClose={onClose}
      phoneSheet
      title={t('feedback.title')}
    >
      <form className="flex flex-col gap-4" noValidate onSubmit={onSubmit}>
        <Field error={categoryError} htmlFor="feedback-category" label={t('feedback.category')}>
          <Select
            aria-required="true"
            disabled={pending}
            id="feedback-category"
            name="feedback-category"
            onChange={(event) => {
              resumeEditing();
              setCategory(event.target.value as FeedbackCategory | '');
            }}
            required
            value={category}
          >
            <option disabled value="">
              {t('feedback.categoryPlaceholder')}
            </option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {t(`feedback.categoryOption.${value}`)}
              </option>
            ))}
          </Select>
        </Field>

        <Field error={subjectError} htmlFor="feedback-subject" label={t('feedback.subject')}>
          <Input
            autoComplete="off"
            disabled={pending}
            id="feedback-subject"
            maxLength={FEEDBACK_SUBJECT_MAX_LENGTH}
            name="feedback-subject"
            onChange={(event) => {
              resumeEditing();
              setSubject(event.target.value);
            }}
            value={subject}
          />
        </Field>

        <Field error={messageError} htmlFor="feedback-message" label={t('feedback.message')}>
          <Textarea
            autoFocus
            disabled={pending}
            id="feedback-message"
            maxLength={FEEDBACK_MESSAGE_MAX_LENGTH}
            name="feedback-message"
            onChange={(event) => {
              resumeEditing();
              setMessage(event.target.value);
            }}
            placeholder={t('feedback.messagePlaceholder')}
            rows={7}
            style={{ resize: 'vertical' }}
            required
            value={message}
          />
        </Field>
        <p className="bt-field__hint -mt-2.5 self-end">
          {t('feedback.messageCounter', {
            count: message.length,
            max: FEEDBACK_MESSAGE_MAX_LENGTH,
          })}
        </p>

        {state === 'error' && submissionError ? (
          <Alert tone="error">{submissionError}</Alert>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={pending} onClick={onClose} type="button">
            {t('common.cancel')}
          </Button>
          <Button loading={pending} type="submit" variant="primary">
            {pending ? t('feedback.submitting') : t('feedback.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
