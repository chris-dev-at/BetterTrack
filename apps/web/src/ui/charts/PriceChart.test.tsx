import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the canvas-backed charting lib: jsdom can't draw, and the wrapper's
// contract is *how* it drives the lib (series type, setData, disposal).
const mocks = vi.hoisted(() => {
  const setData = vi.fn();
  const remove = vi.fn();
  const fitContent = vi.fn();
  const applyOptions = vi.fn();
  const addSeries = vi.fn((_def: unknown, _opts?: unknown) => ({
    setData,
    applyOptions: vi.fn(),
  }));
  const createChart = vi.fn((_el: unknown, _opts?: unknown) => ({
    addSeries,
    applyOptions,
    timeScale: () => ({ fitContent }),
    remove,
  }));
  return { setData, remove, fitContent, applyOptions, addSeries, createChart };
});

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
  AreaSeries: 'AreaSeries',
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

    for (const token of ['1D', '1W', '1M', '6M', '1Y', '5Y', 'Max']) {
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
