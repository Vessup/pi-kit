import type { SemanticImage, WebSession } from "../protocol";

export function restoreFailedDraft(
  current: string,
  failedMessage: string,
): string {
  if (!failedMessage) return current;
  return current ? `${failedMessage}\n\n${current}` : failedMessage;
}

export function restoreFailedImages(
  current: SemanticImage[],
  failedImages: SemanticImage[],
): SemanticImage[] {
  if (failedImages.length === 0) return current;
  // Prioritize the failed payload being restored, then retain as many newer
  // draft attachments as fit within the composer's four-image limit.
  return [...failedImages, ...current].slice(0, 4);
}

export function shouldDefaultToQueueFollowUp(
  session: Pick<WebSession, "status" | "compaction"> | null | undefined,
  immediateSendPending: boolean,
): boolean {
  return Boolean(
    session?.status === "working" &&
      (session.compaction || immediateSendPending),
  );
}
