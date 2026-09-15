import { useMemo, useState } from 'react';

import {
  FEATURE_FLAG_CONFIG_UNREADABLE,
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
import { WorkspaceTabs } from '../components/WorkspaceTabs';
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
 * A row whose STORED configuration could not be read (#1950) is the sharpest
 * case of that rule. The API reports what it is showing as a fallback rather
 * than as fact, and such a row gets a second badge, a note saying so, and a Save
 * that is reachable with the form untouched — because the write that repairs it
 * is "replace what is on disk with what this panel shows", which is not an edit.
 *
 * What a degraded row deliberately does NOT get is a kill switch that sends the
 * whole configuration. The switch stays a one-field patch so two operators — one
 * widening a rollout, one flipping the switch — cannot clobber each other, which
 * is the entire reason the server merges patches. On a degraded row it therefore
 * still 409s, and the console renders the mapped repair instruction instead of
 * the generic banner.
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

/**
 * Whether the configuration this row is showing is what is STORED, or a fallback
 * the API had to invent because the row could not be read. Both degraded
 * outcomes mean the same thing for the write path — only a complete replacement
 * is accepted — so they share one predicate and differ only in what they say.
 */
function isDegraded(flag: AdminFeatureFlag): boolean {
  return flag.stored !== 'parsed';
}

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
   *
   * Onto a row whose stored configuration cannot be read, a merge would have to
   * invent the omitted fields, so the server refuses every partial write with
   * 409 `FEATURE_FLAG_CONFIG_UNREADABLE`. That refusal carries the repair
   * instruction, but its envelope is English-only by policy — so the code is
   * mapped to catalog copy here rather than rendered from the server.
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
      conflictErrorKey: {
        code: FEATURE_FLAG_CONFIG_UNREADABLE,
        messageKey: 'admin.featureFlags.stored.conflictError',
      },
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
    const targeting = { rolloutPercent: percent, allowUserIds: allow, denyUserIds: deny };
    void save.runFor(
      `${flag.key}:rollout`,
      flag.key,
      // On a degraded row this Save IS the repair, so it sends the COMPLETE
      // configuration: all four fields, inheriting nothing from a row the server
      // could not read. `enabled` carries the value the console is showing —
      // which for a salvaged row is the one field that WAS readable, and for an
      // unreadable one is the default the app is already serving — so the write
      // makes the state the estate is in durable instead of guessing a new one.
      //
      // For a healthy row it stays a partial patch, deliberately. Sending all
      // four every time would mean this form overwrites a kill switch some other
      // operator flipped while it sat open — the exact clobber the merge design
      // avoids.
      isDegraded(flag) ? { enabled: flag.enabled, ...targeting } : targeting,
    );
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

      <WorkspaceTabs />

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

/**
 * The second badge: not what the flag DOES, but whether what is shown is what is
 * stored. It sits beside the state badge rather than replacing it, because both
 * facts matter at once — an operator mid-incident needs to know the feature is
 * on AND that the row behind it is damaged.
 *
 * Salvaged and unreadable are told apart on purpose: a salvaged row still has a
 * kill switch that was genuinely read, so the state badge next to it is true; an
 * unreadable row's is the default.
 */
function storedBadge(flag: AdminFeatureFlag, t: ReturnType<typeof useT>) {
  if (flag.stored === 'salvaged') {
    return {
      tone: 'amber' as const,
      label: t('admin.featureFlags.stored.salvagedBadge'),
      note: t('admin.featureFlags.stored.salvagedNote'),
    };
  }
  if (flag.stored === 'unreadable') {
    return {
      tone: 'red' as const,
      label: t('admin.featureFlags.stored.unreadableBadge'),
      note: t('admin.featureFlags.stored.unreadableNote'),
    };
  }
  return null;
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
  const degraded = useMemo(() => storedBadge(flag, t), [flag, t]);
  const dirty = !draftsEqual(draft, draftOf(flag));

  return (
    <Panel padded={false}>
      <PanelHeader
        title={t(`admin.featureFlags.flag.${flag.key}.name`)}
        description={t(`admin.featureFlags.flag.${flag.key}.description`)}
        actions={
          <>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {degraded ? <Badge tone={degraded.tone}>{degraded.label}</Badge> : null}
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

        {/* What is on screen is a FALLBACK, not the stored row — and the note
            says which write repairs it, because a badge alone leaves the
            operator to guess between the switch and the rollout Save (only the
            latter can send a complete configuration). */}
        {degraded ? <p className={cx(TEXT_BODY, 'text-amber-300')}>{degraded.note}</p> : null}

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
            {/* `dirty` is the right gate only while the form mirrors the stored
                row. On a degraded row it does not: saving it UNCHANGED replaces
                an unreadable configuration with the one being served, which is
                the whole repair — so requiring a pointless edit first would put
                the operator's only escape hatch behind a fake state change. */}
            <Button disabled={busy || (!dirty && !degraded)} type="submit">
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
