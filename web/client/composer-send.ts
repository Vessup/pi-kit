import type { WebSession } from "../protocol";

export function shouldDefaultToQueueFollowUp(
  session: Pick<WebSession, "status" | "compaction"> | null | undefined,
  immediateSendPending: boolean,
): boolean {
  return Boolean(
    session?.status === "working" &&
      (session.compaction || immediateSendPending),
  );
}
