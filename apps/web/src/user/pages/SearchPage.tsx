import { AssetSearchBox } from '../components/AssetSearchBox';

/**
 * Dedicated `/search` page (PROJECTPLAN.md §6.2, §7.2).
 * The global ⌘K palette reuses the same `AssetSearchBox` component.
 */
export function SearchPage() {
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">Search</h1>
        <p className="mt-1 text-sm text-neutral-400">
          Find stocks, ETFs, indices, FX pairs and your custom assets.
        </p>
      </div>
      <AssetSearchBox />
    </section>
  );
}
