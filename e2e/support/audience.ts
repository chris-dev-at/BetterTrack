import { expect, type Locator } from '@playwright/test';

type AudienceTier = 'all_friends' | 'specific_friends' | 'group' | 'public_link';

export interface AudienceSelection {
  audience: AudienceTier;
  recipient?: string;
  afterAudienceSelected?: (picker: Locator) => Promise<void>;
}

const AUDIENCE_LABELS: Record<AudienceTier, string> = {
  all_friends: 'All friends',
  specific_friends: 'Specific friends',
  group: 'Friend group',
  public_link: 'Public link',
};

const WIDEN_ACKNOWLEDGMENT = 'I understand this change widens access.';
const PUBLIC_LINK_ACKNOWLEDGMENT = 'I understand that anyone with the link can see this.';

/**
 * Drive an AudiencePicker selection through its privacy-friction ladder. Every
 * genuine widening needs the light confirmation; public links use their
 * separate, stronger acknowledgement instead.
 */
export async function setAudienceThroughLadder(
  picker: Locator,
  selection: AudienceSelection,
): Promise<void> {
  await picker.getByText(AUDIENCE_LABELS[selection.audience], { exact: true }).click();
  await selection.afterAudienceSelected?.(picker);

  if (selection.recipient) {
    await picker.getByText(selection.recipient, { exact: true }).click();
    if (selection.audience === 'specific_friends') {
      await expect(picker.getByText('1 selected')).toBeVisible();
    }
  }

  const acknowledgment =
    selection.audience === 'public_link'
      ? picker.getByRole('checkbox', { name: PUBLIC_LINK_ACKNOWLEDGMENT })
      : picker.getByRole('checkbox', { name: WIDEN_ACKNOWLEDGMENT });
  await expect(acknowledgment).toBeVisible();
  await acknowledgment.check();
  await expect(acknowledgment).toBeChecked();

  const save = picker.getByRole('button', { name: 'Save' });
  await expect(save).toBeEnabled();
  await save.click();
}
