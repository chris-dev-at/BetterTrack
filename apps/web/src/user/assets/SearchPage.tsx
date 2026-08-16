import { useT } from '../../i18n';
import { Page, PageHead, Surface, SurfaceBody } from '../../ui/origin';
import { AssetSearchBox } from '../components/AssetSearchBox';

/**
 * Dedicated `/search` page (PROJECTPLAN.md §6.2, §7.2).
 * The global ⌘K palette reuses the same `AssetSearchBox` component.
 */
export function SearchPage() {
  const t = useT();
  return (
    <Page className="bt-phone-surface bt-assets-family bt-asset-search-page" width="narrow">
      <PageHead sub={t('assets.search.subtitle')} title={t('assets.search.title')} />
      <Surface className="bt-asset-search-surface" tone="raised">
        <SurfaceBody>
          <AssetSearchBox />
        </SurfaceBody>
      </Surface>
    </Page>
  );
}
