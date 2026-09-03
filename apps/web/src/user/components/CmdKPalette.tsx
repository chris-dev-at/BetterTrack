import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';

import type { AssetType, SearchResultItem } from '@bettertrack/contracts';
import { useT } from '../../i18n';
import { Icon, type IconName } from '../../ui/origin';
import { useOverlayEscape } from '../../ui/overlayStack';
import { useFocusTrap } from '../../ui/useFocusTrap';
import {
  SUGGESTED_COMMANDS,
  commandPath,
  filterCommands,
  isCommandConfigured,
  sectionLabelKeyFor,
  withPortfolioScope,
  type CommandEntry,
  type CommandGroup,
} from './commands';
import { ACTIVE_PORTFOLIO_PARAM } from '../routeParams';
import { useDeployCapabilities } from '../../lib/featureFlags';
import { useAssetSearch } from './useAssetSearch';
import { useResolvedPrivacyMode } from '../vault/usePrivacyMode';
import { isParanoidKilledPath } from '../vault/ui/ParanoidSurfaceGate';

interface CmdKPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Command sections, in the order they are offered. */
const GROUP_ORDER: readonly CommandGroup[] = ['create', 'navigate', 'control'];

const GROUP_LABEL_KEY: Record<CommandGroup, string> = {
  create: 'palette.group.actions',
  navigate: 'palette.group.goTo',
  control: 'palette.group.settings',
};

/** Per-section cap: enough to be useful, few enough to keep every section visible. */
const PER_GROUP_LIMIT = 6;
const ASSET_LIMIT = 8;

/**
 * Asset glyphs. Market assets only — search never returns a caller's own custom
 * asset, so there is deliberately no `custom` entry here (V3-P2, issue #325).
 */
const ASSET_ICON: Record<string, IconName> = {
  stock: 'trending-up',
  etf: 'layers',
  index: 'pulse',
  fx: 'refresh',
  commodity: 'globe',
  crypto: 'bolt',
};

/** Market types with a translated singular badge label; anything else reads "Other". */
const BADGED_TYPES = new Set<string>(['stock', 'etf', 'index', 'fx', 'commodity', 'crypto']);

/** Translated singular type label for the row badge (`stock` → "Stock"). */
function assetTypeLabelKey(type: AssetType): string {
  return BADGED_TYPES.has(type) ? `palette.assetType.${type}` : 'palette.assetType.other';
}

/** One navigable palette row. Commands and assets share this exact grammar. */
interface PaletteRow {
  /** Stable within a render pass; also the `aria-activedescendant` target. */
  id: string;
  to: string;
  icon: IconName;
  /** Primary text — a command label or an asset symbol. */
  label: string;
  /** Quiet secondary text: the parent section, or an asset's name/exchange. */
  meta?: string;
  /** Trailing badge (asset type). */
  badge?: string;
  /** Renders the gold planned-surface dot. */
  parked?: boolean;
  /** Symbols read as data, so they set in the mono face. */
  mono?: boolean;
}

interface PaletteSection {
  key: string;
  labelKey: string;
  rows: PaletteRow[];
  /** Row-shaped, non-interactive note (loading / nothing found) under the header. */
  note?: string;
}

/**
 * The universal ⌘K / Ctrl-K palette (PROJECTPLAN.md §6.2; PRODUCT_BLUEPRINT.md §4
 * "Global search / command menu").
 *
 * One input, one row grammar, two layers:
 *  - **Commands first.** Actions, destinations and settings come from the local
 *    {@link COMMANDS} registry, so they are instant and ranked — and they are
 *    what a palette keystroke usually means.
 *  - **Assets underneath**, in their own ruled section, fetched through the
 *    shared {@link useAssetSearch}. The command sections never wait on it.
 *
 * An empty query is a curated *Suggested* list, never a blank void. Rows are
 * pure targets: Enter or a click opens one — no per-row sub-actions (adding to a
 * portfolio or blueprint belongs on the asset page, one click further on).
 */
export function CmdKPalette({ isOpen, onClose }: CmdKPaletteProps) {
  const t = useT();
  const paranoid = useResolvedPrivacyMode() === 'paranoid';
  // Deploy-time capabilities (§13.5 V5-P5): an unconfigured arc's destination is
  // absent from the palette, exactly as it is from the section nav.
  const capabilities = useDeployCapabilities();
  const navigate = useNavigate();
  // The portfolio the palette was opened over, carried into the create rows
  // that write into one portfolio (`withPortfolioScope`).
  const [searchParams] = useSearchParams();
  const activePortfolioId = searchParams.get(ACTIVE_PORTFOLIO_PARAM);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Initial focus (the input, deterministically), Tab containment, an inert
  // background and focus restoration all come from the shared trap. It captures
  // the opener — the topbar search field, or whatever a ⌘K caller was working
  // in — before descendants commit, which is why the focus call cannot live on
  // `autoFocus`.
  const { containerRef, onKeyDown: onTrapKeyDown } = useFocusTrap<HTMLDivElement>({
    active: isOpen,
    inertBackground: true,
    initialFocusRef: inputRef,
  });

  // Escape from anywhere in the overlay — but only when the palette is the
  // innermost open overlay, so anything it opened on top closes alone.
  useOverlayEscape(isOpen, onClose, containerRef);

  // A fresh open starts empty and at the top of the list.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
  }, [isOpen]);

  const trimmed = query.trim();
  const assets = useAssetSearch(query, { enabled: isOpen });
  const commands = useMemo(
    () =>
      filterCommands(trimmed, t).filter(
        (command) =>
          isCommandConfigured(command, capabilities) &&
          (!paranoid || !isParanoidKilledPath(commandPath(command.to))),
      ),
    [capabilities, paranoid, trimmed, t],
  );

  const sections = useMemo<PaletteSection[]>(() => {
    if (trimmed.length === 0) {
      return [
        {
          key: 'suggested',
          labelKey: 'palette.group.suggested',
          rows: SUGGESTED_COMMANDS.filter(
            (entry) =>
              isCommandConfigured(entry, capabilities) &&
              (!paranoid || !isParanoidKilledPath(commandPath(entry.to))),
          ).map((entry, i) => commandRow(entry, `s${i}`, t, activePortfolioId)),
        },
      ];
    }

    const byGroup = new Map<CommandGroup, CommandEntry[]>();
    for (const command of commands) {
      const list = byGroup.get(command.group);
      if (list) list.push(command);
      else byGroup.set(command.group, [command]);
    }
    const commandSections = GROUP_ORDER.filter((group) => byGroup.has(group)).map((group) => ({
      key: group,
      labelKey: GROUP_LABEL_KEY[group],
      rows: byGroup
        .get(group)!
        .slice(0, PER_GROUP_LIMIT)
        .map((entry, i) => commandRow(entry, `${group}${i}`, t, activePortfolioId)),
    }));

    // The asset section always declares itself while a query is running, so the
    // layout never jumps when the async rows land — it only fills in.
    const assetRows = assets.results.slice(0, ASSET_LIMIT).map((item) => assetRow(item, t));
    const assetNote = assets.isFetching
      ? t('palette.assetsLoading')
      : assets.isEnriching
        ? t('assets.searchBox.searchingMore')
        : assets.isError
          ? t('assets.searchBox.failed')
          : assetRows.length === 0
            ? t('palette.assetsEmpty')
            : undefined;

    // Nothing anywhere: one honest line instead of two empty section headers.
    if (commandSections.length === 0 && assetRows.length === 0 && !assets.isFetching) {
      return [];
    }

    return [
      ...commandSections,
      { key: 'assets', labelKey: 'palette.group.assets', rows: assetRows, note: assetNote },
    ];
  }, [
    activePortfolioId,
    assets.isEnriching,
    assets.isError,
    assets.isFetching,
    assets.results,
    capabilities,
    commands,
    paranoid,
    t,
    trimmed,
  ]);

  /** Every row in visual order — what ↑/↓ walk. Group headers are not rows. */
  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

  // Async asset rows append *below*, so a landed response must not yank the
  // highlight back to the top; clamping is all that is needed.
  const active = rows.length === 0 ? -1 : Math.min(activeIndex, rows.length - 1);
  const activeId = active >= 0 ? rows[active]!.id : undefined;

  useEffect(() => {
    setActiveIndex(0);
  }, [trimmed]);

  useEffect(() => {
    if (activeId === undefined) return;
    // `scrollIntoView` is absent in jsdom — optional-call so tests never crash.
    document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  if (!isOpen) return null;

  function open(row: PaletteRow) {
    navigate(row.to);
    onClose();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (rows.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (Math.min(i, rows.length - 1) + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (Math.min(i, rows.length - 1) + rows.length - 1) % rows.length);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(rows.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) open(row);
    }
  }

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  const noResults = trimmed.length > 0 && sections.length === 0;

  // The palette can open above the portalled Control Center. Mounting it in the
  // shell would leave it inside the Control Center's inert background, so give
  // it an independent body-level layer just like the other modal primitives.
  return createPortal(
    <div
      aria-label={t('common.quickSearchAria')}
      aria-modal="true"
      className="bt-app bt-palette-overlay"
      onClick={handleBackdrop}
      onKeyDown={onTrapKeyDown}
      ref={containerRef}
      role="dialog"
      tabIndex={-1}
    >
      {/* The panel routes arrow/Enter keys to the active row: the input keeps DOM
          focus and points at the row through aria-activedescendant (combobox
          pattern), so the keys must be caught above the input, not on it. */}
      <div className="bt-palette" onKeyDown={handleKeyDown}>
        <div className="bt-palette__field">
          <Icon name="search" size={16} />
          <input
            aria-activedescendant={activeId}
            aria-autocomplete="list"
            aria-controls="bt-palette-list"
            aria-expanded="true"
            aria-label={t('palette.inputAria')}
            className="bt-palette__input"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('palette.placeholder')}
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
          <kbd className="bt-kbd">{t('common.escKey')}</kbd>
        </div>

        <ul
          aria-busy={assets.isFetching || undefined}
          aria-label={t('palette.resultsAria')}
          className="bt-palette__body"
          id="bt-palette-list"
          role="listbox"
        >
          {sections.map((section) => (
            <li className="bt-palette__group" key={section.key} role="none">
              <p className="bt-palette__label" id={`bt-palette-h-${section.key}`}>
                {t(section.labelKey)}
              </p>
              <ul
                aria-labelledby={`bt-palette-h-${section.key}`}
                className="bt-palette__rows"
                role="group"
              >
                {section.rows.map((row) => (
                  <Row
                    key={row.id}
                    onActivate={() => open(row)}
                    onHover={() => setActiveIndex(rows.indexOf(row))}
                    row={row}
                    selected={row.id === activeId}
                  />
                ))}
                {section.note ? (
                  <li aria-disabled="true" className="bt-palette__note" role="option">
                    {section.note}
                  </li>
                ) : null}
              </ul>
            </li>
          ))}
        </ul>

        {noResults ? (
          <p className="bt-palette__empty" role="status">
            {t('palette.noResults', { query: trimmed })}
          </p>
        ) : null}

        {trimmed.length === 0 ? (
          <p className="bt-palette__hint">
            <Icon name="info" size={13} />
            {t('palette.hint')}
          </p>
        ) : null}

        <div className="bt-palette__foot">
          <span>
            <kbd className="bt-kbd">↑</kbd>
            <kbd className="bt-kbd">↓</kbd>
            {t('palette.keys.navigate')}
          </span>
          <span>
            <kbd className="bt-kbd">↵</kbd>
            {t('palette.keys.open')}
          </span>
          <span>
            <kbd className="bt-kbd">{t('common.escKey')}</kbd>
            {t('common.escToClose')}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One row: icon chip · primary · quiet meta · optional badge/dot · chevron. */
function Row({
  onActivate,
  onHover,
  row,
  selected,
}: {
  onActivate: () => void;
  onHover: () => void;
  row: PaletteRow;
  selected: boolean;
}) {
  const t = useT();
  // A listbox option owns no keys of its own — the combobox input does (see
  // `handleKeyDown`), which is why a click handler here needs no key handler.
  return (
    <li
      aria-selected={selected}
      className="bt-palette__row"
      id={row.id}
      onClick={onActivate}
      onMouseMove={onHover}
      role="option"
    >
      <span aria-hidden="true" className="bt-palette__chip">
        <Icon name={row.icon} size={15} />
      </span>
      <span className={row.mono ? 'bt-palette__primary is-mono' : 'bt-palette__primary'}>
        {row.label}
      </span>
      {/* Always rendered, even empty: it is the row's flexible column, so the
          trailing badge/dot/chevron cluster stays right-aligned on every row. */}
      <span className="bt-palette__meta">{row.meta ?? ''}</span>
      {row.parked ? (
        <span
          aria-label={t('common.parked')}
          className="bt-dot bt-dot--gold"
          role="img"
          title={t('common.parked')}
        />
      ) : null}
      {row.badge ? <span className="bt-badge bt-palette__badge">{row.badge}</span> : null}
      <Icon name="chevron-right" size={14} style={{ color: 'var(--bt-faint)' }} />
    </li>
  );
}

function commandRow(
  entry: CommandEntry,
  suffix: string,
  t: (k: string) => string,
  portfolioId: string | null,
): PaletteRow {
  const sectionKey = sectionLabelKeyFor(entry.to);
  return {
    id: `bt-palette-row-c-${suffix}`,
    // Same rule as the shell's create menu: a portfolio-scoped action opens on
    // the portfolio the palette was called from, not the default one.
    to: entry.scoped ? withPortfolioScope(entry.to, portfolioId) : entry.to,
    icon: entry.icon,
    label: t(entry.labelKey),
    meta: sectionKey === undefined ? undefined : t(sectionKey),
    parked: entry.parked,
  };
}

function assetRow(item: SearchResultItem, t: (k: string) => string): PaletteRow {
  const place = item.exchange ? `${item.name} · ${item.exchange}` : item.name;
  return {
    id: `bt-palette-row-a-${item.id}`,
    to: `/assets/${item.id}`,
    icon: ASSET_ICON[item.type] ?? 'assets',
    label: item.symbol,
    meta: `${place} · ${item.currency}`,
    badge: t(assetTypeLabelKey(item.type)),
    mono: true,
  };
}
