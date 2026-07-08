import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the canvas-backed charting lib: jsdom can't draw, and the wrapper's
// contract is *how* it drives the lib (series type, setData, disposal).
const mocks = vi.hoisted(() => {
  const setData = vi.fn();
  const update = vi.fn();
  const remove = vi.fn();
  const fitContent = vi.fn();
  const applyOptions = vi.fn();
  const setMarkers = vi.fn();
  const addSeries = vi.fn((_def: unknown, _opts?: unknown) => ({
    setData,
    update,
    applyOptions: vi.fn(),
  }));
  const createChart = vi.fn((_el: unknown, _opts?: unknown) => ({
    addSeries,
    applyOptions,
    timeScale: () => ({ fitContent }),
    remove,
  }));
  const createSeriesMarkers = vi.fn(() => ({ setMarkers }));
  return {
    setData,
    update,
    remove,
    fitContent,
    applyOptions,
    setMarkers,
    addSeries,
    createChart,
    createSeriesMarkers,
  };
});

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
  createSeriesMarkers: mocks.createSeriesMarkers,
  AreaSeries: 'AreaSeries',
  BaselineSeries: 'BaselineSeries',
  LineSeries: 'LineSeries',
  LineType: { Simple: 0, WithSteps: 1, Curved: 2 },
  ColorType: { Solid: 'solid', VerticalGradient: 'gradient' },
  PriceScaleMode: { Normal: 0, Logarithmic: 1, Percentage: 2, IndexedTo100: 3 },
}));

import { overlayColor, PriceChart } from './PriceChart';
import { sampleBenchmarkSeries, sampleOverlaySeries, samplePriceSeries } from './fixtures';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PriceChart', () => {
  test('renders the full range toggle and draws an area series from props', () => {
    render(<PriceChart series={samplePriceSeries} />);

    for (const token of ['1D', '1W', '1M', '3M', '1Y', 'Max']) {
      expect(screen.getByRole('button', { name: token })).toBeInTheDocument();
    }

    expect(mocks.createChart).toHaveBeenCalledTimes(1);
    expect(mocks.addSeries).toHaveBeenCalledTimes(1);
    expect(mocks.addSeries.mock.calls[0]?.[0]).toBe('AreaSeries');
    expect(mocks.setData).toHaveBeenCalledWith(samplePriceSeries);
    expect(mocks.fitContent).toHaveBeenCalled();
  });

  test('step mode uses a stepped line series', () => {
    render(<PriceChart series={samplePriceSeries} mode="step" />);

    expect(mocks.addSeries).toHaveBeenCalledTimes(1);
    expect(mocks.addSeries.mock.calls[0]?.[0]).toBe('LineSeries');
    expect(mocks.addSeries.mock.calls[0]?.[1]).toMatchObject({ lineType: 1 });
  });

  test('benchmark overlay adds a second series and shows its label', () => {
    render(<PriceChart series={samplePriceSeries} benchmark={sampleBenchmarkSeries} />);

    expect(mocks.addSeries).toHaveBeenCalledTimes(2);
    expect(screen.getByText(sampleBenchmarkSeries.label)).toBeInTheDocument();
    expect(mocks.setData).toHaveBeenCalledWith(sampleBenchmarkSeries.series);
  });

  test('entry markers ride the main series as labelled flags (§14)', () => {
    const markers = [
      { time: '2024-06-14', label: 'SPACEX enters' },
      { time: '2024-09-02', label: 'LATE enters' },
    ];
    render(<PriceChart series={samplePriceSeries} markers={markers} />);

    expect(mocks.createSeriesMarkers).toHaveBeenCalledTimes(1);
    expect(mocks.setMarkers).toHaveBeenCalledWith(
      markers.map((m) => ({
        time: m.time,
        position: 'aboveBar',
        shape: 'arrowDown',
        color: expect.any(String),
        text: m.label,
      })),
    );
  });

  test('without markers the marker plugin is never created', () => {
    render(<PriceChart series={samplePriceSeries} />);

    expect(mocks.createSeriesMarkers).not.toHaveBeenCalled();
    expect(mocks.setMarkers).not.toHaveBeenCalled();
  });

  test('asset overlays draw one line each, switch the scale to percentage mode and show legend chips (#122)', () => {
    render(<PriceChart series={samplePriceSeries} overlays={sampleOverlaySeries} />);

    // Main series + one line per overlay asset, each with its palette colour.
    expect(mocks.addSeries).toHaveBeenCalledTimes(1 + sampleOverlaySeries.length);
    sampleOverlaySeries.forEach((overlay, i) => {
      expect(mocks.addSeries.mock.calls[1 + i]?.[0]).toBe('LineSeries');
      expect(mocks.addSeries.mock.calls[1 + i]?.[1]).toMatchObject({ color: overlayColor(i) });
      expect(screen.getByText(overlay.label)).toBeInTheDocument();
      expect(mocks.setData).toHaveBeenCalledWith(overlay.series);
    });

    // Differently-scaled series are only comparable normalized: percentage mode.
    expect(mocks.createChart.mock.calls[0]?.[1]).toMatchObject({
      rightPriceScale: expect.objectContaining({ mode: 2 }),
    });
  });

  test('without overlays the price scale stays in normal (absolute) mode', () => {
    render(<PriceChart series={samplePriceSeries} />);

    expect(mocks.createChart.mock.calls[0]?.[1]).toMatchObject({
      rightPriceScale: expect.objectContaining({ mode: 0 }),
    });
  });

  test('baseline mode draws a zero-centred baseline series (#125)', () => {
    render(<PriceChart series={samplePriceSeries} mode="baseline" />);

    expect(mocks.addSeries).toHaveBeenCalledTimes(1);
    expect(mocks.addSeries.mock.calls[0]?.[0]).toBe('BaselineSeries');
    expect(mocks.addSeries.mock.calls[0]?.[1]).toMatchObject({
      baseValue: { type: 'price', price: 0 },
    });
  });

  test('percentValues formats the axis as % and keeps the scale normal even with overlays (#125)', () => {
    render(<PriceChart series={samplePriceSeries} overlays={sampleOverlaySeries} percentValues />);

    const options = mocks.createChart.mock.calls[0]?.[1] as {
      rightPriceScale: { mode: number };
      localization?: { priceFormatter?: (p: number) => string };
    };
    // The series already are % curves: re-normalizing (percentage scale mode)
    // would divide by a first value of 0 — the scale must stay normal.
    expect(options.rightPriceScale).toMatchObject({ mode: 0 });
    expect(options.localization?.priceFormatter?.(7.1167)).toBe('7.12 %');
  });

  test('empty series renders an empty state without creating a chart', () => {
    render(<PriceChart series={[]} />);

    expect(mocks.createChart).not.toHaveBeenCalled();
    expect(screen.getByText(/no price data/i)).toBeInTheDocument();
  });

  test('loading renders a spinner without creating a chart', () => {
    render(<PriceChart series={samplePriceSeries} loading />);

    expect(mocks.createChart).not.toHaveBeenCalled();
    expect(screen.getByText(/loading chart/i)).toBeInTheDocument();
  });

  test('switches range and mode: toggle updates selection, mode swap re-creates the chart', async () => {
    const onRangeChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <PriceChart series={samplePriceSeries} mode="area" onRangeChange={onRangeChange} />,
    );

    // Default range is 1M; switching to 1Y updates the pressed state + callback.
    expect(screen.getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '1Y' }));
    expect(onRangeChange).toHaveBeenCalledWith('1Y');
    expect(screen.getByRole('button', { name: '1Y' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1M' })).toHaveAttribute('aria-pressed', 'false');

    // Switching the drawing mode disposes the old instance and rebuilds it.
    expect(mocks.createChart).toHaveBeenCalledTimes(1);
    rerender(<PriceChart series={samplePriceSeries} mode="step" onRangeChange={onRangeChange} />);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.createChart).toHaveBeenCalledTimes(2);
    expect(mocks.addSeries.mock.calls.at(-1)?.[0]).toBe('LineSeries');
  });

  test('disposes the chart instance on unmount (no leaks)', () => {
    const { unmount } = render(<PriceChart series={samplePriceSeries} />);
    expect(mocks.remove).not.toHaveBeenCalled();
    unmount();
    expect(mocks.remove).toHaveBeenCalledTimes(1);
  });
});

describe('PriceChart — live-append mode (§6.3, V3-P7b)', () => {
  const base = [
    { time: 1_700_000_000 as never, value: 100 },
    { time: 1_700_000_010 as never, value: 101 },
  ];

  test('a pure tail-growth streams via series.update() instead of a full setData', () => {
    const { rerender } = render(<PriceChart series={base} live showRangeToggle={false} />);
    expect(mocks.setData).toHaveBeenCalledTimes(1); // initial draw

    const grown = [...base, { time: 1_700_000_020 as never, value: 102 }];
    rerender(<PriceChart series={grown} live showRangeToggle={false} />);

    expect(mocks.setData).toHaveBeenCalledTimes(1); // no re-draw
    // Appended from the last drawn point: re-affirm it, then the new one.
    expect(mocks.update.mock.calls.map((c) => c[0])).toEqual([grown[1], grown[2]]);
  });

  test('a replaced series (window/asset switch) falls back to setData', () => {
    const { rerender } = render(<PriceChart series={base} live showRangeToggle={false} />);
    const replaced = [{ time: 1_700_000_005 as never, value: 99 }, ...base.slice(1)];
    rerender(<PriceChart series={replaced} live showRangeToggle={false} />);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.setData).toHaveBeenCalledTimes(2);
  });

  test('without live, growth still re-draws via setData', () => {
    const { rerender } = render(<PriceChart series={base} showRangeToggle={false} />);
    rerender(
      <PriceChart
        series={[...base, { time: 1_700_000_020 as never, value: 102 }]}
        showRangeToggle={false}
      />,
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.setData).toHaveBeenCalledTimes(2);
  });

  test('renders the custom empty message while waiting for the first frame', () => {
    render(<PriceChart series={[]} live emptyMessage="Waiting for live prices…" />);
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for live prices…');
  });
});
