import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { I18nProvider } from '../../i18n';
import { setDiscreetMode, setFormatLocale } from '../../lib/format';

/**
 * The portfolio chart under the Control Center's interface scale (owner bug,
 * 2026-10-29: at 120 %+ the scrubbed point drifts right of the cursor, more so
 * the further right the cursor is).
 *
 * jsdom cannot draw a canvas, so `lightweight-charts` is replaced by a stand-in
 * that keeps the ONE thing this bug is about: how the library turns a mouse
 * event into a plot position. lightweight-charts 5.2.1
 * (`MouseEventHandler._private__makeCompatEvent`) computes
 *
 *     localX = event.clientX - target.getBoundingClientRect().left
 *
 * and then treats `localX` as its own layout px — the px it sized its canvas
 * in. The stand-in does exactly that, then snaps to the nearest point the way
 * the crosshair does on an evenly spaced axis. `layoutPointerEvents.test.ts` pins that
 * formula against the installed library build, so this model cannot quietly
 * drift from the real thing.
 *
 * The geometry is what root `zoom` produces in Chromium (measured in Chromium
 * 153 for this fix): `getBoundingClientRect()` and `clientX` are in rendered
 * px — the layout box times the scale — while `offsetWidth`/`offsetHeight`
 * stay in layout px.
 */
const lib = vi.hoisted(() => {
  /** The pane canvas's layout box, in unscaled CSS px. */
  const LAYOUT = { left: 40, top: 100, width: 600, height: 340 };
  const state = {
    scale: 1,
    data: [] as Array<{ time: string; value: number }>,
    crosshair: null as ((param: unknown) => void) | null,
    canvas: null as HTMLCanvasElement | null,
  };

  function createChart(container: HTMLElement) {
    const canvas = document.createElement('canvas');
    Object.defineProperty(canvas, 'offsetWidth', { configurable: true, value: LAYOUT.width });
    Object.defineProperty(canvas, 'offsetHeight', { configurable: true, value: LAYOUT.height });
    canvas.getBoundingClientRect = () => {
      const s = state.scale;
      const rect = {
        left: LAYOUT.left * s,
        top: LAYOUT.top * s,
        width: LAYOUT.width * s,
        height: LAYOUT.height * s,
      };
      return {
        ...rect,
        x: rect.left,
        y: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        toJSON: () => rect,
      } as DOMRect;
    };
    container.appendChild(canvas);
    state.canvas = canvas;

    canvas.addEventListener('mousemove', (event) => {
      const box = canvas.getBoundingClientRect();
      const localX = event.clientX - box.left;
      const localY = event.clientY - box.top;
      const spacing = LAYOUT.width / (state.data.length - 1);
      const point = state.data[Math.round(localX / spacing)];
      state.crosshair?.(
        point ? { time: point.time, point: { x: localX, y: localY }, seriesData: new Map() } : {},
      );
    });

    return {
      addSeries: () => ({
        setData: (data: Array<{ time: string; value: number }>) => {
          state.data = data;
        },
        update: () => {},
        applyOptions: () => {},
      }),
      applyOptions: () => {},
      timeScale: () => ({ fitContent: () => {}, setVisibleRange: () => {} }),
      subscribeCrosshairMove: (handler: (param: unknown) => void) => {
        state.crosshair = handler;
      },
      remove: () => {
        canvas.remove();
        state.crosshair = null;
      },
    };
  }

  return { LAYOUT, state, createChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: lib.createChart,
  createSeriesMarkers: () => ({ setMarkers: () => {} }),
  AreaSeries: 'AreaSeries',
  BaselineSeries: 'BaselineSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
  TickMarkType: { Year: 0, Month: 1, DayOfMonth: 2, Time: 3, TimeWithSeconds: 4 },
}));

import { PriceChart } from './PriceChart';

/** Five evenly spaced days: the performance curve and its money twin. */
const DAYS = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
const PERFORMANCE = DAYS.map((time, i) => ({ time: time as never, value: i * 2.5 }));
const BALANCE = DAYS.map((time, i) => ({ time: time as never, value: 1000 + i * 100 }));
const LABELS = ['1 Jan 2026', '2 Jan 2026', '3 Jan 2026', '4 Jan 2026', '5 Jan 2026'];

beforeEach(() => {
  setDiscreetMode(false);
  setFormatLocale('de-AT');
  lib.state.scale = 1;
});

function renderPortfolioChart() {
  render(
    <I18nProvider initialLocale="en">
      <PriceChart
        series={PERFORMANCE}
        mode="baseline"
        percentValues
        balanceSeries={BALANCE}
        balanceCurrency="EUR"
        height={340}
      />
    </I18nProvider>,
  );
}

/**
 * Put the mouse over point `index` as the user sees it: the point's layout x,
 * scaled exactly like the canvas it is drawn on — so `clientX` is in rendered
 * px, which is what a real browser reports.
 */
function hoverPoint(index: number) {
  const { LAYOUT, state } = lib;
  const spacing = LAYOUT.width / (DAYS.length - 1);
  const clientX = (LAYOUT.left + index * spacing) * state.scale;
  const clientY = (LAYOUT.top + LAYOUT.height / 2) * state.scale;
  act(() => {
    state.canvas!.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY, bubbles: true }));
  });
}

/** The scrub tooltip is the DOM face of the crosshair: its date names the inspected point. */
function inspectedDate(): HTMLElement {
  return screen.getByText((_, el) => el?.tagName === 'SPAN' && LABELS.includes(el.textContent!));
}

describe('PriceChart — hover inspects the point under the cursor at every interface scale', () => {
  test.each([1, 1.1, 1.2, 1.25, 1.3, 1.4])('at %s× the scrubbed point is the hovered one', (s) => {
    lib.state.scale = s;
    renderPortfolioChart();

    for (const index of [0, 1, 2, 3, 4]) {
      hoverPoint(index);
      expect(inspectedDate()).toHaveTextContent(LABELS[index]!);
      // The tooltip sits in the same zoomed tree as the chart, so its anchor
      // must be the point's LAYOUT x — the scale is applied by the browser.
      // (Close, not equal: the library re-subtracts the rect's left edge from
      // the corrected clientX, which can leave a 1e-14 px float residue.)
      expect(parseFloat(inspectedDate().parentElement!.style.left)).toBeCloseTo(index * 150, 9);
    }
  });

  test('at 125 % the far-right half of the plot no longer drifts past the cursor', () => {
    lib.state.scale = 1.25;
    renderPortfolioChart();

    // Before the fix, the cursor over 4 Jan read localX = 562.5 (450 × 1.25):
    // the 5 Jan point, one full step to the right of what the user pointed at.
    hoverPoint(3);
    expect(inspectedDate()).toHaveTextContent('4 Jan 2026');
    expect(screen.getByText('1,300.00 €')).toBeInTheDocument();
  });
});
