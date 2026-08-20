import type { Theme } from "@earendil-works/pi-coding-agent";

export const FOOTER_CONTRIBUTION_EVENT = "vessup:footer:contribution";

export type FooterUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type FooterContribution = {
  sessionId: string;
  key: string;
  remove?: boolean;
  /** Rendered at the far left, immediately before the directory. */
  identityPrefix?: (theme: Theme) => string | undefined;
  /** Rendered inline after the branch/session identity on the first footer line. */
  identitySuffix?: (theme: Theme) => string | undefined;
  /** Rendered before the active model on the right of the first footer line. */
  modelPrefix?: (theme: Theme) => string | undefined;
  /** Rendered on the right of the usage statistics on the second footer line. */
  statsRight?: (theme: Theme) => string | undefined;
  status?: {
    text: string;
    selected?: boolean;
  };
  usage?: FooterUsage;
  onBranchChange?: () => void;
};

export function parseFooterContribution(
  value: unknown,
): FooterContribution | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (
    typeof event.sessionId !== "string" ||
    typeof event.key !== "string" ||
    !event.key
  )
    return undefined;
  if (event.remove !== undefined && typeof event.remove !== "boolean")
    return undefined;
  if (
    event.identityPrefix !== undefined &&
    typeof event.identityPrefix !== "function"
  )
    return undefined;
  if (
    event.identitySuffix !== undefined &&
    typeof event.identitySuffix !== "function"
  )
    return undefined;
  if (
    event.modelPrefix !== undefined &&
    typeof event.modelPrefix !== "function"
  )
    return undefined;
  if (event.statsRight !== undefined && typeof event.statsRight !== "function")
    return undefined;
  if (
    event.onBranchChange !== undefined &&
    typeof event.onBranchChange !== "function"
  )
    return undefined;
  if (event.status !== undefined) {
    if (!event.status || typeof event.status !== "object") return undefined;
    const status = event.status as Record<string, unknown>;
    if (typeof status.text !== "string") return undefined;
    if (status.selected !== undefined && typeof status.selected !== "boolean")
      return undefined;
  }
  if (
    event.usage !== undefined &&
    (!event.usage || typeof event.usage !== "object")
  )
    return undefined;
  return value as FooterContribution;
}
