import { useT } from '../../i18n';
import { AssetSearchBox } from '../components/AssetSearchBox';

/**
 * Dedicated `/search` page (PROJECTPLAN.md §6.2, §7.2).
 * The global ⌘K palette reuses the same `AssetSearchBox` component.
 */
export function SearchPage() {
  const t = useT();
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-100">
          {t('assets.search.title')}
        </h1>
        <p className="mt-1 text-sm text-neutral-400">{t('assets.search.subtitle')}</p>
      </div>
      <AssetSearchBox />
    </section>
  );
}
