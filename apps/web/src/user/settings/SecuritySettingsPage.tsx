import { useState } from 'react';
import type { FormEvent } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, type SetPinRequest } from '@bettertrack/contracts';

import { ApiError } from '../../lib/apiClient';
import { formatDateTime } from '../../lib/format';
import { disablePin, getMe, getSession, setPin } from '../../lib/userApi';
import { EmptyState, Skeleton } from '../../ui';
import { Alert, Button, TextField } from '../components/ui';

const ME_KEY = ['auth', 'me'] as const;
const SESSION_KEY = ['auth', 'session'] as const;

function pinErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'WEAK_PASSWORD' || err.code === 'VALIDATION_ERROR') return err.message;
    if (err.status >= 500) return 'Something went wrong. Please try again.';
  }
  return 'Could not update your PIN. Please try again.';
}

/** Signed-in-since / expiry line, read from `GET /auth/session`. */
function SessionInfo() {
  const query = useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 30_000,
  });

  return (
    <section className="flex flex-col gap-3 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <h3 className="text-sm font-semibold text-neutral-100">Session</h3>
      {query.isPending ? (
        <Skeleton height="h-6" />
      ) : query.isError ? (
        <EmptyState
          title="Couldn't load your session"
          description="Please try again in a moment."
        />
      ) : (
        <p className="text-sm text-neutral-400">
          Signed in since {formatDateTime(query.data.signedInAt)} — expires after 30 days of
          inactivity ({formatDateTime(query.data.expiresAt)}).
        </p>
      )}
    </section>
  );
}

/** Set/change form used both to enable a PIN and to change an existing one. */
function PinForm({
  submitLabel,
  onDone,
}: {
  submitLabel: string;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [pin, setPinValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (body: SetPinRequest) => setPin(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setPinValue('');
      setConfirm('');
      onDone('Your PIN has been saved.');
    },
    onError: (err) => setError(pinErrorMessage(err)),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pin !== confirm) {
      setError('The PINs do not match.');
      return;
    }
    mutation.mutate({ pin });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Alert tone="error">{error}</Alert> : null}
      <TextField
        label="PIN"
        name="pin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChange={(e) => setPinValue(e.target.value)}
        minLength={MIN_PIN_LENGTH}
        maxLength={MAX_PIN_LENGTH}
        required
        hint={`${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} digits.`}
      />
      <TextField
        label="Confirm PIN"
        name="confirmPin"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        minLength={MIN_PIN_LENGTH}
        maxLength={MAX_PIN_LENGTH}
        required
      />
      <div>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** PIN enable / change / disable card, driven by `pinEnabled` from `getMe`. */
function PinSection({ pinEnabled }: { pinEnabled: boolean }) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const disable = useMutation({
    mutationFn: () => disablePin(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ME_KEY });
      setChanging(false);
      setError(null);
      setNotice('Your PIN has been turned off.');
    },
    onError: (err) => setError(pinErrorMessage(err)),
  });

  return (
    <section className="flex flex-col gap-4 rounded-md border border-neutral-800 bg-neutral-900 p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold text-neutral-100">PIN</h3>
        <p className="text-xs text-neutral-500">
          A PIN is asked each time you re-open BetterTrack. It's a convenience re-confirmation on
          top of your session, not a second factor.
        </p>
      </div>

      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {!pinEnabled ? (
        <PinForm
          submitLabel="Enable PIN"
          onDone={(message) => {
            setNotice(message);
          }}
        />
      ) : changing ? (
        <div className="flex flex-col gap-4">
          <PinForm
            submitLabel="Save new PIN"
            onDone={(message) => {
              setChanging(false);
              setNotice(message);
            }}
          />
          <div>
            <Button type="button" variant="ghost" onClick={() => setChanging(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-neutral-400">Your PIN is on.</p>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setNotice(null);
                setChanging(true);
              }}
            >
              Change PIN
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={disable.isPending}
              onClick={() => {
                setNotice(null);
                disable.mutate();
              }}
            >
              {disable.isPending ? 'Disabling…' : 'Disable PIN'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Settings → Security (PROJECTPLAN.md §6.11). Session info, PIN
 * enable/change/disable (§6.1), and a planned two-factor section. All shapes
 * derive from `@bettertrack/contracts` via the web api-client.
 */
export function SecuritySettingsPage() {
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: ({ signal }) => getMe(signal),
    staleTime: 30_000,
  });

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-neutral-100">Security</h2>
        <p className="text-sm text-neutral-500">Your session, PIN, and two-factor options.</p>
      </div>

      <SessionInfo />

      {me.isPending ? (
        <Skeleton height="h-24" />
      ) : me.isError ? (
        <EmptyState
          title="Couldn't load your security settings"
          description="Please try again in a moment."
        />
      ) : (
        <PinSection pinEnabled={me.data.pinEnabled} />
      )}

      <section className="flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900 p-5">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-100">Two-factor authentication</h3>
          <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs font-medium text-neutral-400">
            Planned
          </span>
        </div>
        <p className="text-sm text-neutral-500">
          Time-based one-time passwords (TOTP) and hardware keys are coming soon.
        </p>
      </section>
    </div>
  );
}
