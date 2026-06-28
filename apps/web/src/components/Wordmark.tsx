/**
 * BetterTrack wordmark (brand spec). "Better" in white and "Track" in gold sit
 * tight together, with an optional lighter, smaller edition label after a normal
 * space: "Admin Panel" (admin area), "Webapp" (the SPA), or "Mobile app" (the
 * future native client).
 *
 * Sizing is inherited from the parent font-size (the edition and the gap are
 * `em`-relative), so the same component works in a compact header and on a large
 * login screen — pass a Tailwind text-size through `className`.
 */
export type WordmarkEdition = 'Admin Panel' | 'Webapp' | 'Mobile app';

export function Wordmark({
  edition,
  className,
}: {
  edition?: WordmarkEdition;
  className?: string;
}) {
  return (
    <span
      className={['inline-flex items-baseline font-bold tracking-tight', className]
        .filter(Boolean)
        .join(' ')}
    >
      <span className="text-white">Better</span>
      <span className="text-[#F6B82E]">Track</span>
      {edition ? (
        <span className="ml-[0.4em] text-[0.78em] font-medium text-[#8A8A8A]">{edition}</span>
      ) : null}
    </span>
  );
}
