import { useState } from 'react';

import { PROFILE_ICON_IDS, type ProfileIconId } from '@bettertrack/contracts';

import { useT } from '../../../i18n';
import { Icon } from '../../../ui/origin';
import { Avatar } from '../../components/Avatar';
import { ProfileIconSvg } from '../../components/profileIcons';

/**
 * The one curated profile-icon picker (§13.5 V5-P0 (c), §6.9). Both entry points
 * — the general one in the Public-profile panel and the paranoid-only row in the
 * Account panel (whose `profile` panel is hidden) — render THIS component, so
 * the two can never drift into offering different ids or a different grid.
 *
 * Presentation only: it owns the collapsed/expanded state and reports the picked
 * id upwards. The caller decides when and how the choice is saved (the profile
 * panel folds it into its form save, the paranoid row writes it on its own), and
 * wraps it in whatever row grammar its panel uses.
 */
export function ProfileIconPicker({
  gridId,
  username,
  value,
  onChange,
}: {
  /** DOM id for the radiogroup, so two pickers can coexist in one document. */
  gridId: string;
  /** Drives the deterministic fallback avatar shown in the collapsed row. */
  username: string;
  /** The currently picked id, or `null` for "no choice — deterministic default". */
  value: ProfileIconId | null;
  /** Picking a tile reports the id; the clear link reports `null`. */
  onChange: (id: ProfileIconId | null) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        aria-controls={gridId}
        aria-expanded={open}
        className="flex items-center gap-3 text-left"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'none',
          border: 0,
          color: 'inherit',
          cursor: 'pointer',
          font: 'inherit',
          padding: 0,
        }}
        type="button"
      >
        <Avatar iconId={value} name={username} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="bt-cc-row__label">{t('profile.icon.title')}</span>
          <span className="bt-cc-row__hint">
            {value
              ? t('profile.icon.picked', { name: t(`profile.icon.name.${value}`) })
              : t('profile.icon.defaultHint')}
          </span>
        </span>
        <Icon
          name="chevron-right"
          size={15}
          style={{
            color: 'var(--bt-faint)',
            flex: 'none',
            transform: open ? 'rotate(90deg)' : undefined,
            transition: 'transform var(--bt-t-fast)',
          }}
        />
      </button>
      {open ? (
        <div aria-label={t('profile.icon.title')} id={gridId} role="radiogroup">
          <div className="grid grid-cols-8 gap-1.5 sm:grid-cols-10">
            {PROFILE_ICON_IDS.map((id) => {
              const active = value === id;
              return (
                // Selection is the one thing gold is for here: the picked tile
                // takes the accent rule + its soft wash, the rest stay on the
                // quiet neutral border.
                <button
                  aria-checked={active}
                  aria-label={t(`profile.icon.name.${id}`)}
                  className="flex aspect-square items-center justify-center"
                  data-icon-id={id}
                  key={id}
                  onClick={() => onChange(id)}
                  role="radio"
                  style={{
                    background: active ? 'var(--bt-gold-soft)' : 'none',
                    border: `1px solid ${active ? 'var(--bt-gold-graphic)' : 'var(--bt-border-strong)'}`,
                    borderRadius: 5,
                    cursor: 'pointer',
                    padding: 0,
                    transition: 'border-color var(--bt-t-fast), background var(--bt-t-fast)',
                  }}
                  type="button"
                >
                  <ProfileIconSvg className="h-full w-full" id={id} />
                </button>
              );
            })}
          </div>
          {value !== null ? (
            <button
              className="bt-link"
              onClick={() => onChange(null)}
              style={{
                background: 'none',
                border: 0,
                cursor: 'pointer',
                fontSize: 12,
                marginTop: 8,
                padding: 0,
              }}
              type="button"
            >
              {t('profile.icon.clear')}
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
