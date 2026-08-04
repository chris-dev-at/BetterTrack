/** Drive responsive hooks in jsdom, which has no native `matchMedia`. */
export function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  window.dispatchEvent(new Event('resize'));
}
