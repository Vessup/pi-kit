const KEYBOARD_OPEN_SHRINK_THRESHOLD = 64;
const KEYBOARD_OPEN_OFFSET_THRESHOLD = 3;

type StandaloneFlag = boolean;

export type AppViewportMeasurement = {
  standalone: StandaloneFlag;
  innerHeight: number;
  screenHeight: number;
  visualHeight?: number;
  visualOffsetTop?: number;
  visualScale?: number;
};

export type AppViewportRect = { top: number; height: number };

function isKeyboardOpenByHeuristic(measurement: AppViewportMeasurement, closedHeight: number): boolean {
  if (!measurement.standalone) return false;
  const visualHeight = measurement.visualHeight ?? measurement.innerHeight;
  const visualOffsetTop = Math.max(0, measurement.visualOffsetTop ?? 0);
  if ((measurement.visualScale ?? 1) !== 1) return true;
  if (visualOffsetTop > KEYBOARD_OPEN_OFFSET_THRESHOLD) return true;
  if (closedHeight - visualHeight > KEYBOARD_OPEN_SHRINK_THRESHOLD) return true;
  return false;
}

/**
 * In standalone, use the visual viewport while the keyboard is active.
 * Otherwise use the known closed-screen height.
 */
export function resolveAppViewportRect(measurement: AppViewportMeasurement): AppViewportRect | undefined {
  if (!isKeyboardOpenByHeuristic(measurement, measurement.screenHeight)) return undefined;
  const visualHeight = measurement.visualHeight ?? measurement.innerHeight;
  const visualOffsetTop = Math.max(0, measurement.visualOffsetTop ?? 0);
  return {
    top: Math.round(visualOffsetTop),
    height: Math.max(0, Math.round(visualHeight)),
  };
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function installAppViewportHeight(): void {
  const root = document.documentElement;
  const viewport = window.visualViewport;

  let lastHeightPx = Number.NaN;
  let lastTopPx = Number.NaN;
  let lastKeyboardOpen = false;

  const collect = (): AppViewportMeasurement => ({
    standalone: isStandalone(),
    innerHeight: window.innerHeight,
    screenHeight: window.screen.height,
    visualHeight: viewport?.height,
    visualOffsetTop: viewport?.offsetTop,
    visualScale: viewport?.scale,
  });

  // Confirmed on-device: window.innerHeight and visualViewport.height both
  // under-report the true screen height in this standalone context, even at
  // rest with the keyboard fully closed (e.g. 894 vs a real 956) — they are
  // not usable as the closed-state height. window.screen.height is the one
  // value that consistently matches the real screen, so it drives the closed
  // layout; visualViewport is only trustworthy for the keyboard-open rect,
  // where it genuinely does shrink to track the keyboard.
  //
  // Polling every animation frame (rather than reacting to resize/scroll
  // events) sidesteps iOS's unreliable visualViewport event firing: any wrong
  // or mid-transition value self-corrects within one frame regardless of
  // whether an event ever fires.
  const tick = () => {
    const measurement = collect();
    if (!measurement.standalone) {
      if (!Number.isNaN(lastHeightPx)) {
        root.style.removeProperty("--pi-app-height");
        root.style.removeProperty("--pi-app-top");
        root.classList.remove("pi-keyboard-open");
        lastHeightPx = Number.NaN;
        lastTopPx = Number.NaN;
        lastKeyboardOpen = false;
      }
    } else {
      const openRect = resolveAppViewportRect(measurement);
      const rect = openRect ?? { top: 0, height: Math.round(measurement.screenHeight) };
      if (rect.height !== lastHeightPx || rect.top !== lastTopPx) {
        root.style.setProperty("--pi-app-height", `${rect.height}px`);
        root.style.setProperty("--pi-app-top", `${rect.top}px`);
        lastHeightPx = rect.height;
        lastTopPx = rect.top;
      }
      const keyboardOpen = openRect !== undefined;
      if (keyboardOpen !== lastKeyboardOpen) {
        root.classList.toggle("pi-keyboard-open", keyboardOpen);
        lastKeyboardOpen = keyboardOpen;
      }
    }
    requestAnimationFrame(tick);
  };

  tick();
}
