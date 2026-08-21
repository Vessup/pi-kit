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

export function shouldShowOptimisticPrompt(
  streamingBehavior: "steer" | "followUp" | undefined,
  sessionStatus: WebSession["status"] | undefined,
): boolean {
  return !(
    streamingBehavior === "followUp" && sessionStatus === "working"
  );
}

export function isQueuedFollowUpResponse(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      "queued" in value &&
      value.queued === true &&
      "reason" in value &&
      value.reason === "followUp",
  );
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
