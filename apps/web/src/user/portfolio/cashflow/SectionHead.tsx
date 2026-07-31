import type { ReactNode } from 'react';

import { PageHead } from '../../../ui/origin';

export interface SectionHeadProps {
  title: string;
  sub: string;
  action?: ReactNode;
  /** True when this block is one section of a larger page rather than the page. */
  embedded?: boolean;
}

/**
 * A heading that knows whether it IS the page or merely a section of one.
 *
 * Tags and rules each used to own a tab, so each opened with a `PageHead`. On
 * the merged Labels page they sit one above the other, and two page heads
 * stacked read as two pages that failed to separate — the same visual weight,
 * twice, with no signal about which is the whole and which is the part. So the
 * embedded form steps down to a section heading and keeps its own action on the
 * same line, which is what "this is a part of something" looks like.
 *
 * Both pages keep the standalone form because the tests mount them directly,
 * and because a section that cannot also stand alone is harder to move later.
 */
export function SectionHead({ title, sub, action, embedded = false }: SectionHeadProps) {
  if (!embedded) return <PageHead actions={action} sub={sub} title={title} />;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="bt-h2">{title}</h2>
        <p className="bt-meta" style={{ marginTop: 2 }}>
          {sub}
        </p>
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </div>
  );
}
