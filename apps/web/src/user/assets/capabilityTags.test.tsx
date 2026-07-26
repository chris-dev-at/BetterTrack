import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { I18nProvider } from '../../i18n';

import { assetCapabilityTags, CapabilityTags } from './capabilityTags';

describe('assetCapabilityTags', () => {
  test.each(['stock', 'etf', 'crypto'])('%s maps to the Parqet capability only', (type) => {
    expect(assetCapabilityTags(type)).toEqual([{ provider: 'parqet' }]);
  });

  test.each(['index', 'unlisted-space-rock'])('%s has no capability mapping', (type) => {
    expect(assetCapabilityTags(type)).toEqual([]);
  });
});

describe('CapabilityTags', () => {
  test.each(['index', 'unlisted-space-rock'])(
    'renders no badge or container for an unsupported %s type',
    (type) => {
      const { container } = render(<CapabilityTags type={type} />);

      expect(container).toBeEmptyDOMElement();
    },
  );

  test('renders the localized Parqet badge and preserves a caller class name', () => {
    const { container } = render(
      <I18nProvider initialLocale="de">
        <CapabilityTags type="stock" className="caller-class" />
      </I18nProvider>,
    );

    expect(screen.getByText('Synchronisiert mit Parqet')).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass('caller-class');
  });
});
