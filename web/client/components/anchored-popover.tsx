import * as React from "react";
import { createPortal } from "react-dom";
import { anchoredPopoverPosition } from "../anchored-position";
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
    let frame: number | undefined;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const next = anchoredPopoverPosition({
        anchor: rect,
        panelWidth: panel?.offsetWidth ?? 240,
        panelHeight: panel?.offsetHeight ?? 200,
        viewport: {
          offsetLeft: viewport?.offsetLeft ?? 0,
          offsetTop: viewport?.offsetTop ?? 0,
          width: viewport?.width ?? window.innerWidth,
          height: viewport?.height ?? window.innerHeight,
        },
        align,
      });
      setPosition((current) => current.left === next.left && current.top === next.top ? current : next);
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };

    update();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleUpdate);
    viewport?.addEventListener("scroll", scheduleUpdate);
    const observer = new ResizeObserver(scheduleUpdate);
    if (anchorRef.current) observer.observe(anchorRef.current);
    if (panelRef.current) observer.observe(panelRef.current);

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
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
