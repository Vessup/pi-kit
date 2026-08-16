export type AnchoredRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type VisibleViewport = {
  offsetLeft: number;
  offsetTop: number;
  width: number;
  height: number;
};

/** Keep a portaled menu inside the visible viewport, including mobile keyboards. */
export function anchoredPopoverPosition(options: {
  anchor: AnchoredRect;
  panelWidth: number;
  panelHeight: number;
  viewport: VisibleViewport;
  align: "start" | "end";
  gap?: number;
  margin?: number;
}): { left: number; top: number } {
  const { anchor, panelWidth, panelHeight, viewport, align } = options;
  const gap = options.gap ?? 6;
  const margin = options.margin ?? 8;
  const minLeft = viewport.offsetLeft + margin;
  const minTop = viewport.offsetTop + margin;
  const maxLeft = Math.max(
    minLeft,
    viewport.offsetLeft + viewport.width - panelWidth - margin,
  );
  const maxTop = Math.max(
    minTop,
    viewport.offsetTop + viewport.height - panelHeight - margin,
  );
  const desiredLeft =
    align === "start" ? anchor.left : anchor.right - panelWidth;
  const below = anchor.bottom + gap;
  const desiredTop =
    below + panelHeight <= viewport.offsetTop + viewport.height - margin
      ? below
      : anchor.top - panelHeight - gap;
  return {
    left: Math.max(minLeft, Math.min(maxLeft, desiredLeft)),
    top: Math.max(minTop, Math.min(maxTop, desiredTop)),
  };
}
