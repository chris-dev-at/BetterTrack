import { useMemo, useState } from 'react';

import {
  FEATURE_FLAG_TARGET_LIST_MAX,
  type AdminFeatureFlag,
  type FeatureFlagKey,
  type UpdateFeatureFlagRequest,
} from '@bettertrack/contracts';

import { useT } from '../../i18n';
import * as api from '../../lib/adminApi';
import { formatDateTime } from '../../lib/format';
import { useAdminMutation } from '../useAdminMutation';
import { useResource } from '../useResource';
import { useWorkspaceEyebrow } from '../useWorkspaceEyebrow';
import {
  Alert,
  Badge,
  Button,
  Panel,
  PanelHeader,
  PageHeader,
  Spinner,
  TextAreaField,
  TextField,
  cx,
} from '../components/ui';
import {
  EDGE_TOP,
  STACK,
  TAP_TARGET,
  TEXT_BODY,
  TEXT_MICRO,
  TEXT_MUTED,
  TEXT_NUM,
} from '../components/tokens';

/**
 * Admin feature kill-switches and their rollout (PROJECTPLAN.md §13.5 V5-P2
 * arc (c), §6.12; #1910).
 *
 * Two controls per flag, kept deliberately separate:
 *
 *  - **The kill switch** — one click, no form, no save step. It exists to stop
 *    something already in progress, and a switch you have to confirm is a switch
 *    that costs seconds during the incident it was built for.
 *  - **The rollout** — percentage plus an allow and a deny list, behind an
 *    EXPLICIT save. Flipping a kill switch must never be a side effect of
 *    dragging a slider, which is the same reasoning W2 applied to the
 *    registration-mode selector (#1572, §16 2026-08-29 ruling 4).
 *
 * The badge states what is actually true, not just on/off: a feature at 25 % is
 * not "On", and an operator reading this page after a partial rollout has to be
 * able to tell those apart at a glance.
 *
 * Every flag's name + description is localized through `admin.featureFlags.flag.*`;
 * the server's English metadata is not rendered.
 */

/** One id per line is the operator-legible form; commas are tolerated on paste. */
function parseIdList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function formatIdList(ids: readonly string[]): string {
  return ids.join('\n');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RolloutDraft {
  percent: string;
  allow: string;
  deny: string;
}

function draftOf(flag: AdminFeatureFlag): RolloutDraft {
  return {
    percent: String(flag.rolloutPercent),
    allow: formatIdList(flag.allowUserIds),
    deny: formatIdList(flag.denyUserIds),
  };
}

function draftsEqual(a: RolloutDraft, b: RolloutDraft): boolean {
  return a.percent === b.percent && a.allow === b.allow && a.deny === b.deny;
}

export function FeatureFlagsPage() {
  const t = useT();
  const eyebrow = useWorkspaceEyebrow();
  const [flags, setFlags] = useState<AdminFeatureFlag[] | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<FeatureFlagKey, RolloutDraft>>>({});
  const [draftErrors, setDraftErrors] = useState<Partial<Record<FeatureFlagKey, string>>>({});

  const resource = useResource((signal) => api.getFeatureFlags(signal), []);
  const { loading, error, reload } = resource;
  // Prefer the optimistic post-write list, falling back to the fetched one.
  const rows = flags ?? resource.data?.flags ?? null;

  /**
   * One mutation for both controls. The server takes a PATCH and merges, so the
   * switch sends `{ enabled }` and the rollout sends the three targeting fields —
   * neither can clobber the other, which is exactly why they can share this.
   */
  const save = useAdminMutation(
    async (key: FeatureFlagKey, patch: UpdateFeatureFlagRequest) => {
      const next = await api.setFeatureFlag(key, patch);
      setFlags(next.flags);
      // Re-seed this flag's draft from what the server actually stored, so a
      // clamped or normalised value is visible rather than silently diverging.
      const saved = next.flags.find((flag) => flag.key === key);
      if (saved) setDrafts((current) => ({ ...current, [key]: draftOf(saved) }));
    },
    {
      errorKey: 'admin.featureFlags.actionError',
      // The `:key` in `PATCH /admin/feature-flags/:key` is a fixed contract enum,
      // not a row another operator can delete: the only way this 404s is the
      // §6.12 "not an admin" answer — an expired admin window (V5-P13c). Signing
      // out beats a banner on a console whose next request will fail the same way.
      notFound: 'session',
    },
  );

  const refresh = () => {
    setFlags(null);
    setDrafts({});
    setDraftErrors({});
    reload();
  };

  const submitRollout = (flag: AdminFeatureFlag, draft: RolloutDraft) => {
    const percent = Number(draft.percent);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      setDraftErrors((current) => ({
        ...current,
        [flag.key]: t('admin.featureFlags.percentError'),
      }));
      return;
    }
    const allow = parseIdList(draft.allow);
    const deny = parseIdList(draft.deny);
    const invalid = [...allow, ...deny].find((id) => !UUID.test(id));
    if (invalid !== undefined) {
      setDraftErrors((current) => ({ ...current, [flag.key]: t('admin.featureFlags.idError') }));
      return;
    }
    if (allow.length > FEATURE_FLAG_TARGET_LIST_MAX || deny.length > FEATURE_FLAG_TARGET_LIST_MAX) {
      setDraftErrors((current) => ({
        ...current,
        [flag.key]: t('admin.featureFlags.listTooLong', { max: FEATURE_FLAG_TARGET_LIST_MAX }),
      }));
      return;
    }
    setDraftErrors((current) => ({ ...current, [flag.key]: undefined }));
    void save.runFor(`${flag.key}:rollout`, flag.key, {
      rolloutPercent: percent,
      allowUserIds: allow,
      denyUserIds: deny,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={eyebrow}
        title={t('admin.featureFlags.title')}
        description={t('admin.featureFlags.subtitle')}
        actions={
          <Button variant="secondary" onClick={refresh}>
            {t('admin.featureFlags.refresh')}
          </Button>
        }
      />

      {save.error ? <Alert tone="error">{save.error}</Alert> : null}

      {loading && !rows ? (
        <Spinner label={t('admin.featureFlags.title')} />
      ) : error && !rows ? (
        <Alert tone="error">
          {t('admin.featureFlags.loadError')}{' '}
          <button className="underline" onClick={reload}>
            {t('admin.featureFlags.refresh')}
          </button>
        </Alert>
      ) : rows ? (
        <div className={STACK}>
          {rows.map((flag) => (
            <FlagPanel
              key={flag.key}
              busy={save.isPending(flag.key) || save.isPending(`${flag.key}:rollout`)}
              draft={drafts[flag.key] ?? draftOf(flag)}
              draftError={draftErrors[flag.key]}
              flag={flag}
              onDraftChange={(next) => setDrafts((current) => ({ ...current, [flag.key]: next }))}
              onReset={() => {
                setDrafts((current) => ({ ...current, [flag.key]: draftOf(flag) }));
                setDraftErrors((current) => ({ ...current, [flag.key]: undefined }));
              }}
              onSaveRollout={(next) => submitRollout(flag, next)}
              onToggle={() => void save.runFor(flag.key, flag.key, { enabled: !flag.enabled })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The honest state badge. "On" is reserved for a flag that every account
 * actually has: enabled, fully rolled, no targeting. Anything narrower says how
 * much narrower, because "On" over a 25 % rollout is the sentence that makes an
 * operator think a feature shipped when it did not.
 *
 * The deny list is deliberately NOT in the badge: it only ever removes accounts
 * from a state the badge already describes, so folding it in would make the
 * label longer without changing what it claims. It is shown in the detail line.
 */
function stateBadge(flag: AdminFeatureFlag, t: ReturnType<typeof useT>) {
  if (!flag.enabled) return { tone: 'neutral' as const, label: t('admin.featureFlags.off') };
  const accounts = flag.allowUserIds.length;
  if (flag.rolloutPercent === 100 && accounts === 0) {
    return { tone: 'green' as const, label: t('admin.featureFlags.on') };
  }
  // `t()` is plain token substitution with no pluralization, so a counter that
  // has to read correctly at one AND many ships the repo's manual one/other pair
  // (`social.count.*` set the convention). "On for 1 accounts" is exactly the
  // kind of sloppiness an operator surface cannot afford.
  const plural = accounts === 1 ? 'one' : 'other';
  if (flag.rolloutPercent === 0 && accounts > 0) {
    return {
      tone: 'sky' as const,
      label: t(`admin.featureFlags.onForAccounts.${plural}`, { count: accounts }),
    };
  }
  if (accounts > 0) {
    return {
      tone: 'sky' as const,
      label: t(`admin.featureFlags.onForPercentAndAccounts.${plural}`, {
        percent: flag.rolloutPercent,
        count: accounts,
      }),
    };
  }
  return {
    tone: 'sky' as const,
    label: t('admin.featureFlags.onForPercent', { percent: flag.rolloutPercent }),
  };
}

function FlagPanel({
  busy,
  draft,
  draftError,
  flag,
  onDraftChange,
  onReset,
  onSaveRollout,
  onToggle,
}: {
  busy: boolean;
  draft: RolloutDraft;
  draftError?: string;
  flag: AdminFeatureFlag;
  onDraftChange: (next: RolloutDraft) => void;
  onReset: () => void;
  onSaveRollout: (next: RolloutDraft) => void;
  onToggle: () => void;
}) {
  const t = useT();
  const badge = useMemo(() => stateBadge(flag, t), [flag, t]);
  const dirty = !draftsEqual(draft, draftOf(flag));

  return (
    <Panel padded={false}>
      <PanelHeader
        title={t(`admin.featureFlags.flag.${flag.key}.name`)}
        description={t(`admin.featureFlags.flag.${flag.key}.description`)}
        actions={
          <>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <Button
              variant={flag.enabled ? 'danger' : 'primary'}
              disabled={busy}
              onClick={onToggle}
            >
              {flag.enabled ? t('admin.featureFlags.disable') : t('admin.featureFlags.enable')}
            </Button>
          </>
        }
      />

      <div className="flex flex-col gap-4 p-4">
        <p className={TEXT_MUTED}>
          {t('admin.featureFlags.lastChangedColumn')}:{' '}
          <span className={TEXT_NUM}>
            {flag.updatedAt ? formatDateTime(flag.updatedAt) : t('admin.featureFlags.never')}
          </span>
        </p>

        {/* The kill switch above owns the whole feature, so while it is OFF the
            rollout below is inert — stated, rather than left for the operator to
            discover by saving a rollout that changes nothing. */}
        {!flag.enabled ? (
          <p className={cx(TEXT_BODY, 'text-amber-300')}>{t('admin.featureFlags.killedNote')}</p>
        ) : null}

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSaveRollout(draft);
          }}
        >
          <p className={TEXT_MICRO}>{t('admin.featureFlags.rolloutHeading')}</p>

          <div className="grid gap-4 md:grid-cols-3">
            <TextField
              className={cx(TAP_TARGET, TEXT_NUM, 'md:max-w-[8rem]')}
              hint={t('admin.featureFlags.percentHint')}
              inputMode="numeric"
              label={t('admin.featureFlags.percentLabel')}
              max={100}
              min={0}
              name={`rollout-percent-${flag.key}`}
              onChange={(event) => onDraftChange({ ...draft, percent: event.target.value })}
              step={1}
              type="number"
              value={draft.percent}
            />
            <TextAreaField
              className={TAP_TARGET}
              hint={t('admin.featureFlags.allowHint')}
              label={t('admin.featureFlags.allowLabel')}
              name={`rollout-allow-${flag.key}`}
              onChange={(event) => onDraftChange({ ...draft, allow: event.target.value })}
              rows={3}
              value={draft.allow}
            />
            <TextAreaField
              className={TAP_TARGET}
              hint={t('admin.featureFlags.denyHint')}
              label={t('admin.featureFlags.denyLabel')}
              name={`rollout-deny-${flag.key}`}
              onChange={(event) => onDraftChange({ ...draft, deny: event.target.value })}
              rows={3}
              value={draft.deny}
            />
          </div>

          {draftError ? <Alert tone="error">{draftError}</Alert> : null}

          <div className={cx('flex flex-wrap items-center gap-2 pt-3', EDGE_TOP)}>
            <Button disabled={busy || !dirty} type="submit">
              {t('admin.featureFlags.saveRollout')}
            </Button>
            <Button disabled={busy || !dirty} onClick={onReset} variant="ghost">
              {t('admin.featureFlags.resetRollout')}
            </Button>
            {dirty ? <span className={TEXT_MUTED}>{t('admin.featureFlags.unsaved')}</span> : null}
          </div>
        </form>
      </div>
    </Panel>
  );
}
