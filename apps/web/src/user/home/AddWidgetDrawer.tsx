import { useT } from '../../i18n';
import { useDeployCapabilities } from '../../lib/featureFlags';
import { Drawer, Icon } from '../../ui/origin';
import type { WidgetType } from './config';
import type { WidgetGroup } from './widgets';
import { WIDGET_GROUPS, widgetsInGroup } from './widgets';

/**
 * The widget catalog, grouped Overview / Charts / Lists with a one-line
 * description each. Adding appends to the end of the board so the new widget
 * lands where the user is already looking (the bottom of the page they just
 * scrolled through), never silently in the middle.
 *
 * A widget declaring a `capability` is offered only where the deployment has it
 * (§13.5 V5-P5: an unconfigured arc's blocks simply disappear) — otherwise the
 * catalog hands out a destination whose only possible render is "not
 * available", the same leak the rail and ⌘K already close. A group left with no
 * offerable widget is dropped whole rather than rendering a bare heading.
 */
export function AddWidgetDrawer({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (type: WidgetType) => void;
}) {
  const t = useT();
  const capabilities = useDeployCapabilities();
  const offered = (group: WidgetGroup) =>
    widgetsInGroup(group).filter(
      (definition) => definition.capability === undefined || capabilities[definition.capability],
    );
  // Resolve each group's offering once, then drop the emptied ones.
  const groups = WIDGET_GROUPS.map((group) => ({ group, items: offered(group) })).filter(
    ({ items }) => items.length > 0,
  );

  return (
    <Drawer onClose={onClose} open={open} title={t('home.builder.addTitle')}>
      {groups.map(({ group, items }) => (
        <div className="bt-home-catalog__group" key={group}>
          <p className="bt-label">{t(`home.builder.group.${group}`)}</p>
          <div className="bt-home-catalog">
            {items.map((definition) => (
              <button
                className="bt-home-catalog__item"
                key={definition.type}
                onClick={() => onAdd(definition.type)}
                type="button"
              >
                <Icon className="bt-home-catalog__icon" name={definition.icon} size={17} />
                <span className="bt-home-catalog__text">
                  <span className="bt-row-title">{t(definition.labelKey)}</span>
                  <span className="bt-row-sub">{t(definition.descriptionKey)}</span>
                </span>
                <Icon className="bt-home-catalog__add" name="plus" size={15} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </Drawer>
  );
}
