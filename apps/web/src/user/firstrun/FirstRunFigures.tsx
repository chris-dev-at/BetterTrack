import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import { SUPPORTED_LOCALES, useI18n, useT } from '../../i18n';
import { getAccountSettings, getTaxSettings } from '../../lib/settingsApi';
import { getProfileSettings } from '../../lib/socialApi';
import { getTwoFactorStatus } from '../../lib/twoFactorApi';
import { getGoogleLinkStatus } from '../../lib/userApi';
import { Icon } from '../../ui/origin';
import { useAuth } from '../AuthContext';
import { Avatar } from '../components/Avatar';
import { readFirstRun } from './firstRunStorage';

/**
 * One small figure per wizard step (`/welcome`).
 *
 * **The rule these follow.** A figure earns its place only if it reflects the
 * user's own state — never as illustration for its own sake. So every figure
 * here is live: it reads the same query keys its step does (React Query dedupes,
 * so no figure ever costs a request) and shows what is actually true right now.
 * Nothing is invented sample data, and nothing restates the question.
 *
 * **Why they stay quiet.** Each is one flat hairline strip, ~64px tall, muted
 * ink, and no gold at all. The question below it is 27px ivory — so the
 * hierarchy is question first, control second, figure last. That is deliberate:
 * the complaint about the reference design was that its graphics outshouted the
 * thing being asked.
 *
 * All of them are `aria-hidden`: they are a visual echo of state the step states
 * in words, so a screen reader would only hear it twice. No charting runtime is
 * imported — money is formatted with `Intl` directly.
 */

const ACCOUNT_SETTINGS_KEY = ['settings', 'account'] as const;
const TAX_SETTINGS_KEY = ['settings', 'taxes'] as const;
const TWO_FACTOR_KEY = ['auth', '2fa', 'status'] as const;
const PROFILE_KEY = ['social', 'profile'] as const;
const GOOGLE_LINK_KEY = ['auth', 'google', 'linkStatus'] as const;

/** The sample amount the preferences figure formats. Not anybody's data. */
const PREVIEW_AMOUNT = 1234.56;

function Strip({ children }: { children: ReactNode }) {
  return (
    <div className="bt-frfig" aria-hidden="true">
      {children}
    </div>
  );
}

function Tile({ icon }: { icon: 'user' | 'mail' | 'shield' | 'globe' | 'percent' | 'check' }) {
  return (
    <span className="bt-frfig__tile">
      <Icon name={icon} size={17} />
    </span>
  );
}

/** Who you are — the account's real avatar, name and address. */
export function ProfileFigure() {
  const { user } = useAuth();
  return (
    <Strip>
      <Avatar name={user?.username ?? ''} iconId={user?.profileIcon ?? null} size="lg" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">{user?.username ?? ''}</strong>
        <span className="bt-frfig__meta">{user?.email ?? ''}</span>
      </span>
    </Strip>
  );
}

/** Whether this address is already verified — the real Google link status. */
export function VerifyEmailFigure() {
  const t = useT();
  const { user } = useAuth();
  const link = useQuery({
    queryKey: GOOGLE_LINK_KEY,
    queryFn: ({ signal }) => getGoogleLinkStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
  const verified = link.data?.linked === true;
  return (
    <Strip>
      <Tile icon="mail" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">{user?.email ?? ''}</strong>
        <span className="bt-frfig__meta">
          {verified ? t('firstrun.figures.verified') : t('firstrun.figures.awaitingDelivery')}
        </span>
      </span>
      <span className={verified ? 'bt-frfig__chip bt-frfig__chip--on' : 'bt-frfig__chip'}>
        {verified ? t('firstrun.figures.on') : t('firstrun.figures.off')}
      </span>
    </Strip>
  );
}

/** Which locks are actually on — one chip each, lit from real state. */
export function SecurityFigure() {
  const t = useT();
  const { user } = useAuth();
  const twoFactor = useQuery({
    queryKey: TWO_FACTOR_KEY,
    queryFn: ({ signal }) => getTwoFactorStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
  const pinOn = user?.pinEnabled === true;
  const totpOn = twoFactor.data?.totpEnabled === true || twoFactor.data?.emailEnabled === true;
  return (
    <Strip>
      <Tile icon="shield" />
      <span className="bt-frfig__chips">
        <span className={pinOn ? 'bt-frfig__chip bt-frfig__chip--on' : 'bt-frfig__chip'}>
          {t('firstrun.figures.pin')}
        </span>
        <span className={totpOn ? 'bt-frfig__chip bt-frfig__chip--on' : 'bt-frfig__chip'}>
          {t('firstrun.figures.twoFactor')}
        </span>
      </span>
    </Strip>
  );
}

/**
 * What the chosen language and currency actually DO — the same amount rendered
 * the way the app will render it from now on. The most useful figure in the run:
 * "de + EUR" is abstract, "1.234,56 €" is not.
 */
export function PreferencesFigure() {
  const { locale } = useI18n();
  const settings = useQuery({
    queryKey: ACCOUNT_SETTINGS_KEY,
    queryFn: ({ signal }) => getAccountSettings(signal),
    staleTime: 30_000,
  });
  const definition = SUPPORTED_LOCALES.find((entry) => entry.code === locale);
  const currency = settings.data?.baseCurrency ?? 'EUR';
  // Intl directly rather than the app's money formatter: this figure exists to
  // show the format itself, and must not be blanked by discreet mode.
  const sample = new Intl.NumberFormat(definition?.intlLocale ?? 'en-GB', {
    style: 'currency',
    currency,
  }).format(PREVIEW_AMOUNT);
  return (
    <Strip>
      <Tile icon="globe" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">{sample}</strong>
        <span className="bt-frfig__meta">{definition?.label ?? locale}</span>
      </span>
    </Strip>
  );
}

/** The stored tax mode, named — so the picker's effect is visible at a glance. */
export function TaxFigure() {
  const t = useT();
  const settings = useQuery({
    queryKey: TAX_SETTINGS_KEY,
    queryFn: ({ signal }) => getTaxSettings(signal),
    staleTime: 30_000,
  });
  const mode = settings.data?.mode;
  const country = settings.data?.country;
  return (
    <Strip>
      <Tile icon="percent" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">
          {mode ? t(`settings.taxes.mode.${mode}.label`) : t('firstrun.figures.notSet')}
        </strong>
        <span className="bt-frfig__meta">{country ?? t('firstrun.figures.taxMeta')}</span>
      </span>
    </Strip>
  );
}

/** Public or private, and the slug that would carry it. */
export function PublicProfileFigure() {
  const t = useT();
  const { user } = useAuth();
  const profile = useQuery({
    queryKey: PROFILE_KEY,
    queryFn: ({ signal }) => getProfileSettings(signal),
    staleTime: 30_000,
  });
  const isPublic = profile.data?.isPublic === true;
  return (
    <Strip>
      <Avatar name={user?.username ?? ''} iconId={user?.profileIcon ?? null} size="lg" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">{`/u/${user?.username ?? ''}`}</strong>
        <span className="bt-frfig__meta">
          {isPublic ? t('firstrun.figures.publicMeta') : t('firstrun.figures.privateMeta')}
        </span>
      </span>
      <span className={isPublic ? 'bt-frfig__chip bt-frfig__chip--on' : 'bt-frfig__chip'}>
        {isPublic ? t('firstrun.figures.public') : t('firstrun.figures.private')}
      </span>
    </Strip>
  );
}

/** How the run actually went — counted from what each step recorded. */
export function DoneFigure() {
  const t = useT();
  const statuses = Object.values(readFirstRun().steps);
  const set = statuses.filter((status) => status === 'complete').length;
  const later = statuses.filter((status) => status === 'skipped').length;
  return (
    <Strip>
      <Tile icon="check" />
      <span className="bt-frfig__stack">
        <strong className="bt-frfig__value">
          {t('firstrun.figures.setCount', { count: set })}
        </strong>
        <span className="bt-frfig__meta">{t('firstrun.figures.laterCount', { count: later })}</span>
      </span>
    </Strip>
  );
}
