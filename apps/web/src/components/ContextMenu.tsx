import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
}

/** Right-click context menu state + opener. Coords come from the click event. */
export function useContextMenu(): {
  menu: ContextMenuState | null;
  openMenu: (e: React.MouseEvent) => void;
  closeMenu: () => void;
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  return {
    menu,
    openMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    closeMenu: () => setMenu(null),
  };
}

/**
 * Directive-compliant context menu: `position: fixed` with viewport-clamped
 * coordinates, portaled to <body> so no overflow container can clip it,
 * z-index 9999, affirmative background, closes on outside click / Esc.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp to viewport once we know the menu's size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      style={{ position: "fixed", top: pos.top, left: pos.left, zIndex: 9999 }}
      role="menu"
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          className={"ctx-menu-item" + (it.danger ? " danger" : "")}
          disabled={it.disabled}
          onClick={() => {
            if (it.disabled) return;
            it.onClick();
            onClose();
          }}
        >
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
