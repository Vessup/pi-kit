import type { WebSession } from "../protocol.js";

export function normalizeLegacySessionUpdate<
  T extends Pick<WebSession, "status">,
>(
  existing:
    | (Pick<WebSession, "status"> & { agentRunning?: boolean })
    | undefined,
  incoming: T,
): Omit<T, "status"> & { status: WebSession["status"] } {
  const staleWorkingUpdate =
    existing?.agentRunning === false && incoming.status === "working";
  if (
    existing?.status === "error" &&
    (incoming.status === "idle" || staleWorkingUpdate)
  ) {
    return { ...incoming, status: "error" };
  }
  if (staleWorkingUpdate) return { ...incoming, status: "idle" };
  return incoming;
}
