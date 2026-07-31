import { useEffect, useRef } from "react";

export type ComposerCommandMenuItem = {
  itemId: string;
  badge: string;
  title: string;
  description: string;
  isCurrent?: boolean;
};

export type ComposerCommandMenuProps = {
  menuId: string;
  label: string;
  items: readonly ComposerCommandMenuItem[];
  activeIndex: number;
  emptyMessage: string | null;
};

export function composerCommandOptionId(
  menuId: string,
  index: number,
): string {
  return `${menuId}-option-${index}`;
}

export function ComposerCommandMenu({
  menuId,
  label,
  items,
  activeIndex,
  emptyMessage,
}: ComposerCommandMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div
      ref={menuRef}
      id={menuId}
      className="composer-command-menu"
      role="listbox"
      aria-label={label}
    >
      <div className="composer-command-menu-heading">{label}</div>
      <div className="composer-command-menu-options">
        {items.length > 0 ? (
          items.map((item, index) => (
            <div
              id={composerCommandOptionId(menuId, index)}
              className={`composer-command-menu-option ${
                index === activeIndex ? "active" : ""
              }`}
              key={item.itemId}
              role="option"
              aria-selected={index === activeIndex}
            >
              <span className="composer-command-menu-badge">
                {item.badge}
              </span>
              <span className="composer-command-menu-copy">
                <span className="composer-command-menu-title">
                  {item.title}
                </span>
                <span className="composer-command-menu-description">
                  {item.description}
                </span>
              </span>
              {item.isCurrent && (
                <span className="composer-command-menu-current">
                  Current
                </span>
              )}
            </div>
          ))
        ) : (
          <div className="composer-command-menu-empty">
            {emptyMessage}
          </div>
        )}
      </div>
      <div className="composer-command-menu-hint" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
        <span><kbd>Tab</kbd> or <kbd>Enter</kbd> Select</span>
        <span><kbd>Esc</kbd> Close</span>
      </div>
    </div>
  );
}
