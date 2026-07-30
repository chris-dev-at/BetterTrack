import { useT } from '../../i18n';
import { Drawer, Icon } from '../../ui/origin';
import type { WidgetType } from './config';
import { WIDGET_GROUPS, widgetsInGroup } from './widgets';

/**
 * The widget catalog, grouped Overview / Charts / Lists with a one-line
 * description each. Adding appends to the end of the board so the new widget
 * lands where the user is already looking (the bottom of the page they just
 * scrolled through), never silently in the middle.
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

  return (
    <Drawer onClose={onClose} open={open} title={t('home.builder.addTitle')}>
      {WIDGET_GROUPS.map((group) => (
        <div className="bt-home-catalog__group" key={group}>
          <p className="bt-label">{t(`home.builder.group.${group}`)}</p>
          <div className="bt-home-catalog">
            {widgetsInGroup(group).map((definition) => (
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
