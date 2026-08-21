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
  return failedImages.length > 0 ? [...failedImages, ...current] : current;
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
