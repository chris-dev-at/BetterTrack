import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  MIN_PASSWORD_LENGTH,
  type ChangePasswordRequest,
  type PortfolioSummary,
} from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { formatDate } from '../../lib/format';
import { listPortfolios, updatePortfolio } from '../../lib/portfolioApi';
import { changePassword, getMe } from '../../lib/userApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, TextField } from '../components/ui';

const ME_KEY = ['auth', 'me'] as const;
const PORTFOLIOS_KEY = ['portfolios'] as const;

/** Friendly message for the codes `POST /auth/change-password` can return. */
function changeErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'INVALID_CREDENTIALS') return 'Your current password is incorrect.';
    if (err.code === 'WEAK_PASSWORD') return err.message;
    if (err.status >= 500) return 'Something went wrong. Please try again.';
  }
  return 'Could not change your password. Please try again.';
}

/** One labelled read-only row in the identity card. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</span>
      <span className="text-sm text-neutral-100">{value}</span>
    </div>
  );
}

function ChangePasswordForm() {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mutation = useMutation({
    mutationFn: (body: ChangePasswordRequest) => changePassword(body),
    onSuccess: () => {
      // Success rotates the session server-side; refetch the identity so the
      // page (and anything else keyed on `getMe`) stays in step.
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setDone(true);
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }
    mutation.mutate(
      { currentPassword, newPassword },
      { onError: (err) => setError(changeErrorMessage(err)) },
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-neutral-100">Change password</h3>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {done ? <Alert tone="success">Your password has been changed.</Alert> : null}
      <TextField
        label="Current password"
        name="currentPassword"
        type="password"
        autoComplete="current-password"
        value={currentPassword}
        onChange={(e) => setCurrentPassword(e.target.value)}
        required
      />
      <TextField
        label="New password"
        name="newPassword"
        type="password"
        autoComplete="new-password"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      />
      <TextField
        label="Confirm new password"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        minLength={MIN_PASSWORD_LENGTH}
        required
      />
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Updating…' : 'Update password'}
        </Button>
      </div>
    </form>
  );
}

function SharingToggle({ portfolio }: { portfolio: PortfolioSummary }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(false);
  const shared = portfolio.visibility === 'friends';

  const mutation = useMutation({
    mutationFn: (visibility: PortfolioSummary['visibility']) =>
      updatePortfolio(portfolio.id, { visibility }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PORTFOLIOS_KEY });
      setError(false);
    },
    onError: () => setError(true),
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">Share with friends</h3>
        <p className="text-xs text-neutral-500">
          Share this portfolio with friends: friends can view it read-only. Private keeps it visible
          only to you.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Share this portfolio with friends"
        className="inline-flex w-fit rounded-md ring-1 ring-inset ring-neutral-700"
      >
        <SharingChoice
          label="No"
          selected={!shared}
          busy={mutation.isPending}
          onSelect={() => shared && mutation.mutate('private')}
        />
        <SharingChoice
          label="Yes"
          selected={shared}
          busy={mutation.isPending}
          onSelect={() => !shared && mutation.mutate('friends')}
        />
      </div>
      {error ? <Alert tone="error">Couldn't save that change. Please try again.</Alert> : null}
    </div>
  );
}

function SharingChoice({
  label,
  selected,
  busy,
  onSelect,
}: {
  label: string;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={busy}
      onClick={onSelect}
      className={
        'px-4 py-2 text-sm font-medium transition-colors first:rounded-l-md last:rounded-r-md ' +
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:cursor-not-allowed ' +
        (selected ? 'bg-sky-600 text-white' : 'text-neutral-300 hover:bg-neutral-800')
      }
    >
      {label}
    </button>
  );
}

/**
 * Settings → Account (PROJECTPLAN.md §6.11). Shows the identity read from
 * `GET /auth/me` (username, email, member-since, the fixed EUR base currency),
 * a change-password form, and the default portfolio's private↔friends sharing
 * toggle (§6.8). All shapes derive from `@bettertrack/contracts`.
 */
export function AccountSettingsPage() {
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });
  const portfolios = useQuery({
    queryKey: PORTFOLIOS_KEY,
    queryFn: ({ signal }) => listPortfolios(signal),
    staleTime: 30_000,
  });

  const defaultPortfolio =
    portfolios.data?.portfolios.find((p) => p.isDefault) ?? portfolios.data?.portfolios[0];

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">Account</h2>
        <p className="text-sm text-neutral-500">
          Your identity, password, and sharing preferences.
        </p>
      </div>

      <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        {me.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton height="h-6" />
            <Skeleton height="h-6" />
          </div>
        ) : me.isError ? (
          <EmptyState
            title="Couldn't load your account"
            description="Please try again in a moment."
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Username" value={me.data.username} />
            <Field label="Email" value={me.data.email} />
            <Field label="Member since" value={formatDate(me.data.createdAt)} />
            <Field label="Base currency" value={`${me.data.baseCurrency} (fixed)`} />
          </div>
        )}
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <ChangePasswordForm />
      </section>

      <section className="rounded-md border border-neutral-800 bg-neutral-900 p-5">
        {portfolios.isPending ? (
          <Skeleton height="h-16" />
        ) : portfolios.isError || !defaultPortfolio ? (
          <EmptyState
            title="Couldn't load your portfolio"
            description="Sharing preferences are unavailable right now."
          />
        ) : (
          <SharingToggle portfolio={defaultPortfolio} />
        )}
      </section>
    </div>
  );
}
