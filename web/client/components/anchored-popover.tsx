import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/utils";

type AnchoredPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end";
};

export function AnchoredPopover({ open, onOpenChange, anchorRef, children, className, align = "end" }: AnchoredPopoverProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState({ left: 8, top: 8 });

  React.useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = panel?.offsetWidth ?? 240;
      const height = panel?.offsetHeight ?? 200;
      const left = align === "start" ? rect.left : rect.right - width;
      const preferredTop = rect.bottom + 6;
      const top = preferredTop + height <= window.innerHeight - 8
        ? preferredTop
        : Math.max(8, rect.top - height - 6);
      setPosition({
        left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
        top,
      });
    };
    update();
    const frame = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [align, anchorRef, open]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [anchorRef, onOpenChange, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={cn("fixed z-[70] rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-2xl shadow-black/60", className)}
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}
