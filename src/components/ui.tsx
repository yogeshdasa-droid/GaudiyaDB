import { ReactNode, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { hueOf } from "../api";

export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={`modal ${wide ? "wide" : ""}`} onMouseDown={(e) => e.stopPropagation()}>
        <header className="modal-head">
          {icon && <span className="modal-icon">{icon}</span>}
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Colored pill for a collection name (same hue everywhere). */
export function CollectionChip({ name, onClick }: { name: string; onClick?: () => void }) {
  return (
    <span className={`chip ${onClick ? "clickable" : ""}`} style={{ "--h": hueOf(name) } as React.CSSProperties} onClick={onClick}>
      <i className="dot" />
      {name}
    </span>
  );
}

/** Counts up to `value` with an ease-out animation. */
export function AnimatedNumber({ value, format }: { value: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 700);
      const v = a + (value - a) * (1 - Math.pow(1 - p, 3));
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{format ? format(shown) : Math.round(shown).toLocaleString()}</>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

/** Drag handle between two panes; reports the new width of the left pane. */
export function Splitter({ onDrag, onDoubleClick }: { onDrag: (dx: number) => void; onDoubleClick?: () => void }) {
  const last = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    last.current = e.clientX;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.body.classList.add("resizing");
  };
  const onMove = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
    onDrag(e.clientX - last.current);
    last.current = e.clientX;
  };
  const onUp = () => document.body.classList.remove("resizing");
  return (
    <div
      className="splitter"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={onDoubleClick}
    />
  );
}
