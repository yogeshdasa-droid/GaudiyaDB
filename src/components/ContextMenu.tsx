import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export type MenuItem =
  | {
      label: string;
      icon?: LucideIcon;
      onClick: () => void;
      danger?: boolean;
      disabled?: boolean;
      hint?: string;
    }
  | "sep";

export interface MenuState {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(menu.x, window.innerWidth - r.width - 6)),
      y: Math.max(6, menu.y + r.height > window.innerHeight - 6 ? menu.y - r.height : menu.y),
    });
  }, [menu]);

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("wheel", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("wheel", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {menu.title && <div className="ctx-title">{menu.title}</div>}
      {menu.items.map((it, i) =>
        it === "sep" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            className={it.danger ? "danger" : ""}
            disabled={it.disabled}
            onMouseDown={(e) => e.preventDefault() /* keep text selection / input focus */}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            {it.icon ? <it.icon size={15} /> : <span className="ctx-noicon" />}
            <span className="ctx-label">{it.label}</span>
            {it.hint && <kbd className="kbd">{it.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
