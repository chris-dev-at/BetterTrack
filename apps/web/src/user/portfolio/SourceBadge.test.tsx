import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';

import { SourceBadge, sourceTagLabel } from './SourceBadge';
import { useT } from '../../i18n';

/**
 * SourceBadge (V5-P0c, #552). `manual` is silent (anti-bloat); every other tag
 * renders a compact, labelled pill so imported/synced rows are unmistakable.
 */

describe('SourceBadge', () => {
  test('renders nothing for a manual row (anti-bloat — manual stays quiet)', () => {
    const { container } = render(<SourceBadge source="manual" />);
    expect(container).toBeEmptyDOMElement();
  });

  test('labels an import tag with the (prettified) broker name', () => {
    render(<SourceBadge source="import:trade_republic" />);
    expect(screen.getByText('Imported · Trade Republic')).toBeInTheDocument();
  });

  test('labels a sync tag with the provider name', () => {
    render(<SourceBadge source="sync:parqet" />);
    expect(screen.getByText('Synced · Parqet')).toBeInTheDocument();
  });

  test('labels the reserved standing-order tag', () => {
    render(<SourceBadge source="standing-order" />);
    expect(screen.getByText('Standing order')).toBeInTheDocument();
  });

  test('prettifies an unknown import slug rather than showing the raw id', () => {
    render(<SourceBadge source="import:some_broker" />);
    expect(screen.getByText('Imported · Some Broker')).toBeInTheDocument();
  });
});

/** A tiny probe component so sourceTagLabel is exercised through a real translator. */
function LabelProbe({ source }: { source: string }) {
  const t = useT();
  return <span data-testid="label">{String(sourceTagLabel(t, source))}</span>;
}

describe('sourceTagLabel', () => {
  test('returns null for manual (so callers can render nothing)', () => {
    render(<LabelProbe source="manual" />);
    expect(screen.getByTestId('label')).toHaveTextContent('null');
  });
});
