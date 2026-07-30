import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { cx } from '../../lib/cx';
import { Button, Empty, PageHead } from '../../ui/origin';
import { useAuth } from '../AuthContext';
import { AddWidgetDrawer } from './AddWidgetDrawer';
import {
  addWidget,
  defaultLayout,
  moveWidget,
  moveWidgetToSlot,
  placementSlots,
  readHomeConfig,
  removeWidget,
  setWidgetSettings,
  setWidgetSize,
  writeHomeConfig,
  type HomeConfig,
  type WidgetType,
} from './config';
import { resolveWidgetScope, usePortfoliosQuery } from './homeData';
import { WidgetFrame, type PlacementAxis } from './WidgetFrame';
import { widgetDefinition } from './widgets';

/**
 * Home — a widget board the user composes (R2 home-widgets workstream).
 *
 * The screen is a minimal greeting plus widgets: which ones, in which order, how
 * wide, in which display form and scoped to what is entirely the user's choice,
 * persisted client-side under `bt.home.v1` (see `config.ts`). A user who never
 * opens the builder gets {@link defaultLayout} — the command center Home has
 * always shown.
 *
 * Composition rules the board enforces:
 *  - **one focal point.** The net-worth hero is the only loud element; every
 *    other widget is a quiet label header over un-boxed content.
 *  - **no explainer copy.** The widgets are the page.
 *  - **one primary action.** "Customize" while reading, "Done" while editing.
 *
 * ## Editing: one set of lines, two actions
 *
 * Entering the builder opens the board up (wider gaps — see `.bt-home-grid`'s
 * `is-editing`) so that every position *between* widgets has room of its own.
 * Each of those positions is a button:
 *
 *  - **nothing picked up** ⇒ it is a ⊕ that opens the widget drawer and inserts
 *    the chosen widget exactly there;
 *  - **a widget picked up** (its grip pressed) ⇒ the legal positions become
 *    "Move here" targets, and clicking one moves it.
 *
 * Reordering is click-to-place rather than live dragging: a pointer-drag
 * implementation hit-tested every `pointermove` and reordered mid-gesture, so a
 * cursor in a gap or over a widget's own chrome resolved to nothing and the board
 * either stalled or jumped a step nobody asked for. A discrete choice between
 * labelled targets has no in-between state to get wrong, behaves the same under a
 * finger, and is one operation for keyboard and mouse alike. The ↑/↓ buttons stay
 * as the single-step fast path.
 */

/** Two rects count as the same grid row when their tops agree within this. */
const ROW_EPSILON = 2;

/** How close to the grid's right edge counts as "this row is full". */
const EDGE_EPSILON = 2;

/**
 * Which boundary each insertion slot divides, read off the **real** layout.
 *
 * There are `widgets.length + 1` slots. A slot is a *column* boundary (vertical
 * line) only when the widgets on either side of it actually sit on one row; every
 * other slot is a *row* boundary (horizontal line). Measured rather than derived
 * from the widgets' declared sizes because the 12-column grid re-flows at two
 * breakpoints and auto-placement decides row breaks from the running total — a
 * line drawn on the wrong axis is the one that ends up crossing a widget.
 *
 * Slot 0 is always a row boundary: inserting before everything makes a new first
 * row. The trailing slot follows whether the last row still has room — if the last
 * widget already reaches the grid's right edge, an appended widget starts a new
 * row underneath.
 */
function measureSlotAxes(grid: HTMLElement): PlacementAxis[] {
  const cells = Array.from(grid.querySelectorAll<HTMLElement>(':scope > [data-widget-id]'));
  if (cells.length === 0) return [];
  const rects = cells.map((cell) => cell.getBoundingClientRect());
  const gridRect = grid.getBoundingClientRect();

  const axes: PlacementAxis[] = ['h'];
  for (let index = 1; index < rects.length; index += 1) {
    const previous = rects[index - 1]!;
    const current = rects[index]!;
    axes.push(Math.abs(previous.top - current.top) <= ROW_EPSILON ? 'v' : 'h');
  }
  const last = rects[rects.length - 1]!;
  axes.push(last.right >= gridRect.right - EDGE_EPSILON ? 'h' : 'v');
  return axes;
}

function sameAxes(a: readonly PlacementAxis[], b: readonly PlacementAxis[]): boolean {
  return a.length === b.length && a.every((axis, index) => axis === b[index]);
}

export function HomePage() {
  const t = useT();
  const { user } = useAuth();

  const [config, setConfig] = useState<HomeConfig>(() => readHomeConfig());
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /**
   * Where a widget chosen from the drawer should land, or null for "at the end"
   * (the header's own Add button). Set by the ⊕ on a specific line.
   */
  const [addSlot, setAddSlot] = useState<number | null>(null);
  /** The widget picked up and waiting for a destination, or null. */
  const [armedId, setArmedId] = useState<string | null>(null);
  const [axes, setAxes] = useState<PlacementAxis[]>([]);
  const gridRef = useRef<HTMLDivElement>(null);

  const portfoliosQuery = usePortfoliosQuery();
  const portfolios = portfoliosQuery.data?.portfolios ?? [];

  /**
   * Every board edit writes straight through to storage. The builder has no
   * Save/Cancel affordance, so an eagerly-persisted board is what the user
   * expects from direct manipulation — and it means closing the tab mid-edit
   * never silently discards the layout.
   */
  const update = useCallback((next: HomeConfig) => {
    setConfig(next);
    writeHomeConfig(next);
  }, []);

  const disarm = useCallback(() => setArmedId(null), []);

  const stopEditing = useCallback(() => {
    setEditing(false);
    setAddOpen(false);
    setAddSlot(null);
    setArmedId(null);
    writeHomeConfig(config);
  }, [config]);

  // Escape is the universal way out of a picked-up widget, matching the settings
  // popover's own dismissal. Bound only while something is armed.
  useEffect(() => {
    if (armedId === null) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setArmedId(null);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [armedId]);

  /**
   * Re-measure whenever the board could have re-flowed: entering/leaving the
   * builder (which changes the gaps), any change to the widget list or their
   * sizes, and any resize of the grid itself. The stored value is replaced only
   * when it actually differs, so a ResizeObserver callback can never feed a
   * render loop.
   */
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) {
      setAxes((previous) => (previous.length === 0 ? previous : []));
      return;
    }
    const measure = () => {
      const next = measureSlotAxes(grid);
      setAxes((previous) => (sameAxes(previous, next) ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [editing, config.widgets]);

  const armedIndex = armedId === null ? -1 : config.widgets.findIndex((w) => w.id === armedId);
  /**
   * Which positions are offered right now. With a widget picked up, only the ones
   * that would actually move it (see {@link placementSlots}); with nothing picked
   * up but the builder open, every position, because a *new* widget can go
   * anywhere. Outside the builder: none.
   */
  const openSlots: number[] =
    armedIndex >= 0
      ? placementSlots(config.widgets.length, armedIndex)
      : editing
        ? Array.from({ length: config.widgets.length + 1 }, (_, slot) => slot)
        : [];

  const place = useCallback(
    (slot: number) => {
      if (armedId === null) return;
      update(moveWidgetToSlot(config, armedId, slot));
      setArmedId(null);
    },
    [armedId, config, update],
  );

  function openDrawerAt(slot: number | null) {
    setAddSlot(slot);
    setAddOpen(true);
  }

  function onAdd(type: WidgetType) {
    update(
      addWidget(
        config,
        type,
        widgetDefinition(type).defaultSettings,
        addSlot ?? config.widgets.length,
      ),
    );
    setAddOpen(false);
    setAddSlot(null);
  }

  /**
   * One position's button. The accessible name always says *where* ("before Net
   * worth", "at the end"); the pill shows the short action, because the position
   * is already conveyed by where the line is.
   */
  function target(slot: number, axisFallback: PlacementAxis = 'h') {
    if (!openSlots.includes(slot)) return null;
    const before = config.widgets[slot];
    const at = before === undefined ? null : { title: t(widgetDefinition(before.type).labelKey) };
    const moving = armedIndex >= 0;
    return {
      label: moving
        ? at === null
          ? t('home.builder.placeEnd')
          : t('home.builder.placeBefore', at)
        : at === null
          ? t('home.builder.addEnd')
          : t('home.builder.addBefore', at),
      axis: axes[slot] ?? axisFallback,
      mode: moving ? ('move' as const) : ('add' as const),
      onSelect: () => (moving ? place(slot) : openDrawerAt(slot)),
    };
  }

  const greeting = user?.username ? `${t('home.greeting')}, ${user.username}` : t('home.greeting');

  return (
    <div>
      <PageHead
        actions={
          editing ? (
            <>
              <Button icon="plus" onClick={() => openDrawerAt(null)}>
                {t('home.builder.add')}
              </Button>
              <Button onClick={() => update(defaultLayout())} variant="quiet">
                {t('home.builder.reset')}
              </Button>
              <Button onClick={stopEditing} variant="primary">
                {t('home.builder.done')}
              </Button>
            </>
          ) : (
            <Button icon="sliders" onClick={() => setEditing(true)} variant="quiet">
              {t('home.builder.customize')}
            </Button>
          )
        }
        title={greeting}
      />

      {config.widgets.length === 0 ? (
        <Empty
          action={
            <Button onClick={() => openDrawerAt(null)} variant="primary">
              {t('home.builder.add')}
            </Button>
          }
          center
          icon="grid"
          title={t('home.builder.emptyBoard')}
        >
          <button className="bt-link" onClick={() => update(defaultLayout())} type="button">
            {t('home.builder.reset')}
          </button>
        </Empty>
      ) : (
        <div className={cx('bt-home-grid', editing && 'is-editing')} ref={gridRef}>
          {config.widgets.map((widget, index) => {
            const definition = widgetDefinition(widget.type);
            const scope = resolveWidgetScope(portfolios, widget.settings.scope, {
              supportsScope: definition.supportsScope,
              allowsAll: definition.scopeAllowsAll !== false,
            });
            const { Component } = definition;
            // Each widget hosts the line in the gap before it; the last one also
            // hosts the trailing one, so every slot has a host cell and none of
            // them needs a grid item of its own (which would reflow the board).
            const isLast = index === config.widgets.length - 1;
            return (
              <WidgetFrame
                armed={armedId === widget.id}
                count={config.widgets.length}
                definition={definition}
                editing={editing}
                index={index}
                key={widget.id}
                onArmToggle={() =>
                  setArmedId((current) => (current === widget.id ? null : widget.id))
                }
                onCancelPlacement={disarm}
                onMove={(to) => {
                  update(moveWidget(config, index, to));
                  disarm();
                }}
                onRemove={() => {
                  update(removeWidget(config, widget.id));
                  disarm();
                }}
                onResize={(size) => update(setWidgetSize(config, widget.id, size))}
                onSettingsChange={(patch) => update(setWidgetSettings(config, widget.id, patch))}
                placeAfter={isLast ? target(config.widgets.length) : null}
                placeBefore={target(index)}
                portfolios={portfolios}
                scopeLabel={scope.single?.name ?? null}
                widget={widget}
              >
                <Component
                  onSettingsChange={(patch) => update(setWidgetSettings(config, widget.id, patch))}
                  portfolios={portfolios}
                  portfoliosLoading={portfoliosQuery.isLoading}
                  scopedPortfolio={scope.single}
                  scopedPortfolios={scope.portfolios}
                  settings={widget.settings}
                  size={widget.size}
                />
              </WidgetFrame>
            );
          })}
        </div>
      )}

      <AddWidgetDrawer
        onAdd={onAdd}
        onClose={() => {
          setAddOpen(false);
          setAddSlot(null);
        }}
        open={addOpen}
      />
    </div>
  );
}
