import type { Locator, Page } from '@playwright/test';

const CASH_SOURCES_LABEL = 'Cash sources';
const CASH_MOVEMENTS_LABEL = 'Cash movements';

/**
 * The responsive cash surfaces render table rows on desktop and list-item cards
 * on phone widths. Keep both presentations behind the same locator so flow
 * specs assert the product behavior rather than a particular shell's markup.
 */
function responsiveRows(page: Page, label: string): Locator {
  // The responsive shells are mutually exclusive: rendering both would make
  // this union's positional locators ambiguous.
  return page
    .getByRole('table', { name: label })
    .locator('tbody > tr')
    .or(page.getByRole('list', { name: label }).getByRole('listitem'));
}

export function cashSourceRows(page: Page): Locator {
  return responsiveRows(page, CASH_SOURCES_LABEL);
}

export function cashSourceRow(page: Page, index: number): Locator {
  return cashSourceRows(page).nth(index);
}

export function cashSourceAction(source: Locator, name: string): Locator {
  return source.getByRole('button', { name, exact: true });
}

function cashMovementRows(page: Page): Locator {
  return responsiveRows(page, CASH_MOVEMENTS_LABEL);
}

/** A Movements-tab row/card for a movement carrying `note`. */
export function cashMovementRow(page: Page, note: string): Locator {
  return cashMovementRows(page).filter({ hasText: note });
}
