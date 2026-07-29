import { useCallback, useRef, useState, type PointerEvent } from 'react';

import { useT } from '../../i18n';
import { Button, Empty, PageHead } from '../../ui/origin';
import { useAuth } from '../AuthContext';
import { AddWidgetDrawer } from './AddWidgetDrawer';
import {
  addWidget,
  defaultLayout,
  moveWidget,
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
 */
export function HomePage() {
  const t = useT();
  const { user } = useAuth();

  const [config, setConfig] = useState<HomeConfig>(() => readHomeConfig());
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragRef = useRef<string | null>(null);

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

  const stopEditing = useCallback(() => {
    setEditing(false);
    setAddOpen(false);
    writeHomeConfig(config);
  }, [config]);

  // ── Pointer drag-to-reorder (dependency-free) ──
  // The grip captures the pointer, so every move event bubbles to the grid; we
  // hit-test the widget under the cursor and reorder live. Keyboard users get
  // the same operation from the ↑/↓ buttons in the same chrome.
  const onDragStart = useCallback((event: PointerEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    dragRef.current = id;
    setDraggingId(id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const held = dragRef.current;
      if (held === null) return;
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const overId = target?.closest('[data-widget-id]')?.getAttribute('data-widget-id');
      if (!overId || overId === held) return;
      const from = config.widgets.findIndex((widget) => widget.id === held);
      const to = config.widgets.findIndex((widget) => widget.id === overId);
      if (from < 0 || to < 0) return;
      update(moveWidget(config, from, to));
    },
    [config, update],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setDraggingId(null);
  }, []);

  function onAdd(type: WidgetType) {
    update(addWidget(config, type, widgetDefinition(type).defaultSettings));
    setAddOpen(false);
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
        <div
          className="bt-home-grid"
          onPointerCancel={endDrag}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
        >
          {config.widgets.map((widget, index) => {
            const definition = widgetDefinition(widget.type);
            const scope = resolveWidgetScope(portfolios, widget.settings.scope, {
              supportsScope: definition.supportsScope,
              allowsAll: definition.scopeAllowsAll !== false,
            });
            const { Component } = definition;
            return (
              <WidgetFrame
                count={config.widgets.length}
                definition={definition}
                dragging={draggingId === widget.id}
                editing={editing}
                index={index}
                key={widget.id}
                onDragStart={(event) => onDragStart(event, widget.id)}
                onMove={(to) => update(moveWidget(config, index, to))}
                onRemove={() => update(removeWidget(config, widget.id))}
                onResize={(size) => update(setWidgetSize(config, widget.id, size))}
                onSettingsChange={(patch) => update(setWidgetSettings(config, widget.id, patch))}
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
