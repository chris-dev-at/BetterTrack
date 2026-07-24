import { describe, expect, test } from 'vitest';

import de from './messages/de.json';

type MessageNode = string | { [key: string]: MessageNode };

function flattenStrings(node: MessageNode, values: string[] = []): string[] {
  if (typeof node === 'string') {
    values.push(node);
    return values;
  }

  for (const child of Object.values(node)) flattenStrings(child, values);
  return values;
}

describe('German Forecast translations', () => {
  test('use informal address throughout the Forecast subtree', () => {
    const formalAddress = /\b(?:Sie|Ihr|Ihnen|Ihren|Ihre|Ihrem|Ihres|Ihrer)\b/;
    const formalStrings = flattenStrings(de.forecast).filter((value) => formalAddress.test(value));

    expect(formalStrings).toEqual([]);
    expect(de.forecast.subtitle).toBe(
      'Projiziere dein Portfolio in die Zukunft und rechne schnell nach.',
    );
    expect(de.forecast.projection.whatIf.add).toBe('Was-wäre-wenn-Plan hinzufügen');
  });

  test('keeps Forecast interpolation placeholders unchanged', () => {
    expect(de.forecast.projection.projectedLabel).toBe('Prognose in {{years}} Jahren');
    expect(de.forecast.projection.whatIf.defaultLabel).toBe('Was-wäre-wenn {{n}}');
    expect(de.forecast.standingOrders.list.buyAmount).toBe('Kaufe {{quantity}} × {{symbol}}');
  });
});
