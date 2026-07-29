import { useCallback, useEffect, useState } from 'react';

import { useT } from '../../i18n';
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
import { WidgetFrame } from './WidgetFrame';
import { widgetDefinition } from './widgets';

/**
 * Home — a widget board the user composes (R2 home-widgets workstream).
 *
 * The screen is a minimal greeting plus widgets: which ones, in which order, how
 * wide and scoped to what is entirely the user's choice, persisted client-side
 * under `bt.home.v1` (see `config.ts`). A user who never opens the builder gets
 * {@link defaultLayout} — the command center Home has always shown.
 *
 * Composition rules the board enforces:
 *  - **one focal point.** The net-worth hero is the only loud element; every
 *    other widget is a quiet label header over un-boxed content.
 *  - **no explainer copy.** The widgets are the page.
 *  - **one primary action.** "Customize" while reading, "Done" while editing.
 *
 * Reordering is **click-to-place**, not live dragging. The grip picks a widget up
 * (arms it); every legal destination then shows as a gold insertion line the user
 * clicks. This replaced a pointer-drag implementation whose hit-testing produced
 * dead and jumpy spots mid-gesture — a discrete choice between labelled targets
 * cannot land "between" anything, works identically on touch, and is the same
 * operation for keyboard users as for the mouse. The ↑/↓ buttons stay as the fast
 * path for a single-step nudge.
 */
export function HomePage() {
  const t = useT();
  const { user } = useAuth();

  const [config, setConfig] = useState<HomeConfig>(() => readHomeConfig());
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  /** The widget picked up and waiting for a destination, or null. */
  const [armedId, setArmedId] = useState<string | null>(null);

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

  const armedIndex = armedId === null ? -1 : config.widgets.findIndex((w) => w.id === armedId);
  /**
   * Which gaps the armed widget may go into. Empty whenever nothing is armed, so
   * a board that is merely in edit mode shows no lines at all.
   */
  const openSlots = armedIndex < 0 ? [] : placementSlots(config.widgets.length, armedIndex);

  const place = useCallback(
    (slot: number) => {
      if (armedId === null) return;
      update(moveWidgetToSlot(config, armedId, slot));
      setArmedId(null);
    },
    [armedId, config, update],
  );

  function onAdd(type: WidgetType) {
    update(addWidget(config, type, widgetDefinition(type).defaultSettings));
    setAddOpen(false);
  }

  /** The label a target announces: the widget it lands in front of, or the end. */
  function slotLabel(slot: number): string {
    const before = config.widgets[slot];
    return before === undefined
      ? t('home.builder.placeEnd')
      : t('home.builder.placeBefore', { title: t(widgetDefinition(before.type).labelKey) });
  }

  const greeting = user?.username ? `${t('home.greeting')}, ${user.username}` : t('home.greeting');

  return (
    <div>
      <PageHead
        actions={
          editing ? (
            <>
              <Button icon="plus" onClick={() => setAddOpen(true)}>
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
            <Button onClick={() => setAddOpen(true)} variant="primary">
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
        <div className="bt-home-grid">
          {config.widgets.map((widget, index) => {
            const definition = widgetDefinition(widget.type);
            const scope = resolveWidgetScope(portfolios, widget.settings.scope, {
              supportsScope: definition.supportsScope,
              allowsAll: definition.scopeAllowsAll !== false,
            });
            const { Component } = definition;
            // Each widget owns the line in the gap before it; the last one also
            // owns the "at the end" line, so every slot has a host cell and none
            // of them needs a grid item of its own (which would reflow the board).
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
                placeAfter={
                  isLast && openSlots.includes(config.widgets.length)
                    ? {
                        label: slotLabel(config.widgets.length),
                        onSelect: () => place(config.widgets.length),
                      }
                    : null
                }
                placeBefore={
                  openSlots.includes(index)
                    ? { label: slotLabel(index), onSelect: () => place(index) }
                    : null
                }
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

      <AddWidgetDrawer onAdd={onAdd} onClose={() => setAddOpen(false)} open={addOpen} />
    </div>
  );
}
