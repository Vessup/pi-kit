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

export type AnchoredPopoverBelowPosition = {
  left: number;
  top: number;
  maxHeight: number;
  placement: "above" | "below";
  visible: boolean;
};

/** Position a menu below an anchor when possible without covering the anchor. */
export function anchoredPopoverBelowPosition(options: {
  anchor: AnchoredRect;
  panelWidth: number;
  viewport: VisibleViewport;
  align: "start" | "end";
  panelMaxHeight?: number;
  minPanelHeight?: number;
  gap?: number;
  margin?: number;
}): AnchoredPopoverBelowPosition {
  const {
    anchor,
    panelWidth,
    viewport,
    align,
    panelMaxHeight = Number.POSITIVE_INFINITY,
    minPanelHeight = 96,
    gap = 6,
    margin = 8,
  } = options;
  const viewportBottom = viewport.offsetTop + viewport.height;
  const roomBelow = Math.max(
    0,
    viewportBottom - margin - (anchor.bottom + gap),
  );
  const roomAbove = Math.max(
    0,
    anchor.top - gap - (viewport.offsetTop + margin),
  );
  const placement =
    roomBelow >= minPanelHeight || roomBelow >= roomAbove
      ? "below"
      : "above";
  const room = placement === "below" ? roomBelow : roomAbove;
  const maxHeight = Math.max(0, Math.min(room, panelMaxHeight));
  const minLeft = viewport.offsetLeft + margin;
  const maxLeft = Math.max(
    minLeft,
    viewport.offsetLeft + viewport.width - panelWidth - margin,
  );
  const desiredLeft =
    align === "start" ? anchor.left : anchor.right - panelWidth;
  return {
    left: Math.max(minLeft, Math.min(maxLeft, desiredLeft)),
    top:
      placement === "below"
        ? anchor.bottom + gap
        : Math.max(
            viewport.offsetTop + margin,
            anchor.top - gap - maxHeight,
          ),
    maxHeight,
    placement,
    visible: room > 0,
  };
}

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
