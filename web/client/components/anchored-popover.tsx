import * as React from "react";
import { createPortal } from "react-dom";
import {
  anchoredPopoverBelowPosition,
  anchoredPopoverPosition,
} from "../anchored-position";
import { cn } from "../lib/utils";

type AnchoredPopoverProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end";
  /** "auto" flips above the anchor when there is no room below; "below" stays under it. */
  placement?: "auto" | "below";
  /** Size the panel to the anchor's width instead of its content. */
  matchAnchorWidth?: boolean;
};

function panelMaxHeightCap(panel: HTMLElement | null): number | undefined {
  if (!panel) return undefined;
  const css = window.getComputedStyle(panel).maxHeight;
  const parsed = css ? Number.parseFloat(css) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function AnchoredPopover({
  open,
  onOpenChange,
  anchorRef,
  children,
  className,
  align = "end",
  placement = "auto",
  matchAnchorWidth = false,
}: AnchoredPopoverProps) {
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = React.useState({ left: 8, top: 8 });
  const [anchorWidth, setAnchorWidth] = React.useState<number | undefined>(
    undefined,
  );
  const [maxHeight, setMaxHeight] = React.useState<number | undefined>(
    undefined,
  );
  const [hasRoom, setHasRoom] = React.useState(true);
  // Computed maxHeight reflects our inline override once applied, so remember
  // the stylesheet cap (e.g. max-h-64) separately to avoid ratcheting down.
  const classMaxHeightRef = React.useRef<number | undefined>(undefined);
  const appliedMaxHeightRef = React.useRef<number | undefined>(undefined);

  React.useLayoutEffect(() => {
    if (!open) return;
    classMaxHeightRef.current = undefined;
    appliedMaxHeightRef.current = undefined;
    panelRef.current?.style.removeProperty("max-height");
    setMaxHeight(undefined);
    setHasRoom(true);
    let frame: number | undefined;
    const update = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      setAnchorWidth((current) =>
        current === rect.width ? current : rect.width,
      );
      const viewport = window.visualViewport;
      const viewportBox = {
        offsetLeft: viewport?.offsetLeft ?? 0,
        offsetTop: viewport?.offsetTop ?? 0,
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
      };
      const panelWidth = matchAnchorWidth
        ? rect.width
        : (panel?.offsetWidth ?? 240);
      if (placement === "below") {
        // Prefer the conventional position under the field, but with the
        // mobile keyboard open there may be no room: cap the panel height to
        // the available space and flip above rather than covering the input.
        const computedCap = panelMaxHeightCap(panel);
        if (
          computedCap !== undefined &&
          computedCap !== appliedMaxHeightRef.current
        ) {
          classMaxHeightRef.current = computedCap;
        }
        const next = anchoredPopoverBelowPosition({
          anchor: rect,
          panelWidth,
          viewport: viewportBox,
          align,
          panelMaxHeight: classMaxHeightRef.current,
        });
        setHasRoom((current) =>
          current === next.visible ? current : next.visible,
        );
        appliedMaxHeightRef.current = next.maxHeight;
        setMaxHeight((current) =>
          current === next.maxHeight ? current : next.maxHeight,
        );
        setPosition((current) =>
          current.left === next.left && current.top === next.top
            ? current
            : next,
        );
        return;
      }
      const next = anchoredPopoverPosition({
        anchor: rect,
        panelWidth,
        panelHeight: panel?.offsetHeight ?? 200,
        viewport: viewportBox,
        align,
      });
      setPosition((current) =>
        current.left === next.left && current.top === next.top ? current : next,
      );
    };
    const scheduleUpdate = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        update();
      });
    };

    // iOS can change the visual viewport while the keyboard opens or pans
    // without dispatching a resize/scroll event. Keep the menu aligned while
    // it is open so it never settles over the field after that transition.
    let pollFrame: number | undefined;
    const poll = () => {
      update();
      pollFrame = requestAnimationFrame(poll);
    };
    update();
    pollFrame = requestAnimationFrame(poll);
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
      if (pollFrame !== undefined) cancelAnimationFrame(pollFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      viewport?.removeEventListener("resize", scheduleUpdate);
      viewport?.removeEventListener("scroll", scheduleUpdate);
    };
  }, [align, anchorRef, matchAnchorWidth, open, placement]);

  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      )
        return;
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
      className={cn(
        "fixed z-[70] rounded-lg border border-zinc-700 bg-zinc-950 p-1 shadow-2xl shadow-black/60",
        className,
      )}
      style={{
        ...position,
        ...(matchAnchorWidth && anchorWidth !== undefined
          ? { width: anchorWidth }
          : {}),
        ...(placement === "below" && maxHeight !== undefined
          ? { maxHeight }
          : {}),
        ...(placement === "below" && !hasRoom
          ? { pointerEvents: "none", visibility: "hidden" }
          : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
